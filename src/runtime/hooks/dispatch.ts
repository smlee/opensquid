/**
 * Hook dispatcher: turns a runtime `Event` + loaded packs into a Claude Code
 * hook decision (`exit code 0 = allow | 2 = block` + optional stderr message).
 *
 * Sits between the per-host hook binaries (`pre-tool-use.ts`, `stop.ts`,
 * `user-prompt-submit.ts`, `session-end.ts`) and the rule evaluator. Each hook
 * binary is a thin shell that:
 *   1. Reads stdin → parses into an Event of the right `kind`.
 *   2. Loads active packs + builds the function registry (bootstrap.ts).
 *   3. Calls `dispatchEvent` to produce `{ exitCode, stderr }`.
 *   4. Writes stderr, exits with the code.
 *
 * The dispatcher walks `packs × skills × rules`, runs each rule's process via
 * `evaluateProcess`, and short-circuits on the FIRST verdict. The first-match
 * semantics matter: a high-priority pack's block decision must not be
 * overridden by a later pack's warn. Pack ordering is the loader's
 * responsibility (Task 1.19); the dispatcher trusts the order it's given.
 *
 * AUTO.1 event-kind filter: before walking a skill's rules, the dispatcher
 * checks `event.kind ∈ skill.triggers.map(t => t.kind)`. Skills that don't
 * subscribe to the incoming event kind are skipped entirely. This keeps
 * tool-call hooks from re-running schedule/webhook/file-changed skills and
 * vice versa. A skill that wants to fire on multiple kinds lists them all
 * (e.g. `triggers: [{kind: tool_call}, {kind: schedule, cron: ...}]`). The
 * default trigger list (when the YAML block is omitted) is a single
 * `tool_call` entry — preserves Phase 1–7 dispatcher behavior verbatim.
 *
 * PR-followup policy resolution (replaces hard-coded `block_tool`):
 *   1. Pack-shipped `drift_response.yaml` → `Pack.driftResponse` (loaded by
 *      `loadPack`). For each fired rule, the dispatcher consults
 *      `pack.driftResponse?.per_rule[rule.id] ?? pack.driftResponse?.default`.
 *   2. Pack without `drift_response.yaml` → falls back to the historical
 *      Phase 1 default of `block_tool` (NOT the schema's `block_tool`
 *      default — that only fires when the file IS present but omits the
 *      field; here we want the "no policy declared at all" branch).
 *   3. `corrective_skills` map (`auto_correct` policy support) is threaded
 *      into `applyDriftResponse` via the `DriftDispatchCtx` argument so
 *      `auto_correct` policies can look up their corrective skill name.
 *
 * Pack-agnostic discipline: the dispatcher does NOT special-case
 * sangmin-personal-rules or any other named pack. It reads whatever each
 * pack's `driftResponse` field contains; missing/empty/absent all flow
 * through the same `??` chain.
 *
 * Exit-code mapping (Claude Code hook protocol):
 *   block_tool   → { exitCode: 2, stderr: message }
 *   warn         → { exitCode: 0, stderr: message }   (allow, but surface)
 *   halt         → { exitCode: 0, stderr: '' }        (Task 1.14 wires real halt)
 *   notify_pause → { exitCode: 0, stderr: '' }        (Task 1.18 wires channels)
 *
 * Halt and notify_pause exit 0 deliberately for Phase 1: the runtime can't
 * actually halt the parent agent's task loop from a hook, and channel
 * notifications need infrastructure that doesn't ship until later phases.
 * Mapping them to exit 0 means a misconfigured pack-declared policy won't
 * silently block tools during Phase 1; the real behavior lands when its
 * machinery does.
 *
 * Imports from: runtime/types.js, runtime/evaluator.js, runtime/drift_response.js,
 * functions/registry.js.
 * Imported by: runtime/hooks/*.ts (per-hook binaries).
 */

import type { EvalCtx, FunctionRegistry } from '../../functions/registry.js';
import { applyDriftResponse } from '../drift_response.js';
import { evaluateProcess } from '../evaluator.js';
import type { DriftPolicy, Event, Pack } from '../types.js';

export interface DispatchResult {
  exitCode: 0 | 2;
  stderr: string;
  /**
   * G.4 — aggregated `inject_context` payloads from every skill that fired
   * during this dispatch. Empty array on the common (no-injection) path.
   *
   * Only the `UserPromptSubmit` hook bin actually emits these as host
   * context (Claude Code's `hookSpecificOutput.additionalContext` JSON
   * envelope). Other hook bins ignore the array (the dispatcher writes a
   * stderr warning when an `inject_context` fires on a non-`prompt_submit`
   * event so misconfiguration is visible).
   *
   * Block-verdict + inject_context COEXIST: the block wins on `exitCode`,
   * but the injections are still aggregated and returned so the user sees
   * the recall context alongside the block message. Per Phase-2 lock #7.
   */
  contextInjections: string[];
}

/**
 * G.2 dispatch-trace marker.
 *
 * Emits `[opensquid-dispatch] event=<kind> rules=<N> packs=<N>` to STDERR at
 * the END of every `dispatchEvent` call. Three reasons stderr (not stdout):
 *   1. Claude Code parses stdout as JSON for some hook events; polluting it
 *      with diagnostic text would break the host contract.
 *   2. Claude Code only surfaces stderr to the user when exit code is non-zero
 *      (per the hook contract); on exit 0 the marker stays invisible to the
 *      user but visible to CI / `opensquid doctor hooks` subprocess probes.
 *   3. Matches the convention opensquid uses elsewhere in stderr.
 *
 * Default-on; users can silence with `OPENSQUID_DISPATCH_TRACE=0`. The
 * absence of this marker line in a subprocess probe is the load-bearing
 * signal that the hook bin silently no-op'd (the G.1 root-cause failure
 * mode). See `hooks.bin.integration.test.ts` + `src/setup/cli/doctor.ts`.
 */
function emitDispatchMarker(eventKind: string, ruleCount: number, packCount: number): void {
  if (process.env.OPENSQUID_DISPATCH_TRACE === '0') return;
  process.stderr.write(
    `[opensquid-dispatch] event=${eventKind} rules=${String(ruleCount)} packs=${String(packCount)}\n`,
  );
}

export async function dispatchEvent(
  event: Event,
  packs: Pack[],
  registry: FunctionRegistry,
  sessionId: string,
): Promise<DispatchResult> {
  // Count rules walked across all skills so the marker carries a meaningful
  // signal (rules=0 means dispatch ran but no skill subscribed to this kind;
  // rules=N means N rules were evaluated up to the short-circuit point).
  let rulesWalked = 0;
  // G.4 — aggregate inject_context payloads across every rule in every
  // skill. Kept across the full walk (verdict short-circuit still returns
  // any injections that fired BEFORE the verdict — by-design coexistence).
  const contextInjections: string[] = [];
  // Stderr warnings buffer when an `inject_context` fires on an event kind
  // OTHER than `prompt_submit`. Misconfiguration signal per Phase-2 lock #4.
  let warnBuf = '';
  for (const pack of packs) {
    for (const skill of pack.skills) {
      // AUTO.1: skip the skill entirely if no trigger subscribes to this
      // event kind. `skill.triggers` is guaranteed non-empty by the schema
      // (`.min(1)`) — an omitted YAML block defaults to `[{kind: 'tool_call'}]`.
      // Using `.some` rather than `.includes` because each trigger is a
      // discriminated-union object, not a bare string.
      if (!skill.triggers.some((t) => t.kind === event.kind)) continue;
      for (const rule of skill.rules) {
        // Phase 4: destination_check rules fire on the scheduler tick
        // (`destination_scheduler.ts` → `check_destination` primitive), not
        // through the per-event process walker. Skip them here so the
        // dispatcher only walks track_check processes.
        if (rule.kind === 'destination_check') continue;
        rulesWalked += 1;
        const ctx: EvalCtx = {
          event,
          bindings: new Map(),
          sessionId,
          packId: pack.name,
          // PR-followup: thread pack-shipped `models.yaml` into eval context
          // so LLM primitives can resolve aliases from the pack's declared
          // baseline. Spread-conditional to keep `EvalCtx` clean for packs
          // that ship no `models.yaml` (`exactOptionalPropertyTypes` rejects
          // explicit `undefined` on an optional slot).
          ...(pack.models !== undefined ? { packModels: pack.models } : {}),
        };
        const result = await evaluateProcess(rule.process, ctx, registry);

        // G.4 — `inject_context` is a non-blocking terminal RuleResult.
        // Aggregate and continue walking; only `UserPromptSubmit` hook bin
        // actually emits the array. Other hook bins discard with a warning.
        if (result.kind === 'inject_context') {
          if (event.kind === 'prompt_submit') {
            contextInjections.push(result.content);
          } else {
            warnBuf +=
              `[opensquid] WARN: rule "${rule.id}" in skill "${skill.name}" (pack "${pack.name}") ` +
              `emitted inject_context on event kind "${event.kind}"; only "prompt_submit" surfaces ` +
              `injections (drop). Update the skill's triggers: block.\n`;
          }
          continue;
        }

        if (result.kind !== 'verdict') continue;

        // PR-followup: resolve drift-response policy from the pack's
        // `drift_response.yaml` (folded into `Pack.driftResponse` by
        // `loadPack`). Precedence: per-rule override → pack default →
        // historical Phase 1 hard-coded `block_tool` (preserves the previous
        // behavior for packs that don't ship the file at all).
        //
        // `rule.id` is required on every rule by the Skill schema, so the
        // `per_rule` lookup is always well-defined.
        const driftResponse = pack.driftResponse;
        const resolvedPolicy: DriftPolicy =
          driftResponse?.per_rule[rule.id] ?? driftResponse?.default ?? 'block_tool';
        // `corrective_skills` is only consulted by the `auto_correct` policy
        // inside `applyDriftResponse`; passing it unconditionally is safe
        // because the dispatcher ignores it for every other policy.
        const action = applyDriftResponse(result.verdict, resolvedPolicy, {
          ...(driftResponse !== undefined
            ? { correctiveSkills: driftResponse.corrective_skills }
            : {}),
        });
        switch (action.kind) {
          case 'block_tool':
            emitDispatchMarker(event.kind, rulesWalked, packs.length);
            return {
              exitCode: 2,
              stderr: appendWarn(action.message, warnBuf),
              contextInjections,
            };
          case 'warn':
            emitDispatchMarker(event.kind, rulesWalked, packs.length);
            return {
              exitCode: 0,
              stderr: appendWarn(action.message, warnBuf),
              contextInjections,
            };
          case 'halt':
          case 'notify_pause':
          case 'auto_correct':
          case 'escalate':
            // Phase 1 stub: real halt = Task 1.14; real notify = Task 1.18;
            // `auto_correct` + `escalate` action descriptors are interpreted
            // by `runtime/auto_correct.ts` + `runtime/escalate.ts` at the
            // hook-binary layer (out of scope for this dispatcher's per-event
            // walk). Until those layers wire from this site, return allow +
            // empty stderr so a pack-declared future-policy verdict doesn't
            // accidentally block the tool call.
            emitDispatchMarker(event.kind, rulesWalked, packs.length);
            return {
              exitCode: 0,
              stderr: appendWarn('', warnBuf),
              contextInjections,
            };
        }
      }
    }
  }
  emitDispatchMarker(event.kind, rulesWalked, packs.length);
  return { exitCode: 0, stderr: appendWarn('', warnBuf), contextInjections };
}

/**
 * Append the buffered inject-context misuse warnings to whatever stderr the
 * dispatcher otherwise produced. Keeps the warning visible alongside a
 * block / warn message rather than getting swallowed by the verdict
 * short-circuit. Empty inputs short-circuit to '' (no spurious newline).
 */
function appendWarn(stderr: string, warnBuf: string): string {
  if (warnBuf === '') return stderr;
  if (stderr === '') return warnBuf.trimEnd();
  return `${stderr}\n${warnBuf.trimEnd()}`;
}

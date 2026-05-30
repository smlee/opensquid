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
import { Matcher, matchesEvent } from '../load_matchers.js';
import { partitionSkills } from '../pinned_skills.js';
import { advanceSkillTicks, type SkillTicks } from '../session_state.js';
import { RequiresCache, skillRequiresHold } from '../skill_requires.js';
import { UnloadCondition, shouldUnload, type TickState } from '../unload_conditions.js';
import type { ActivationScope } from '../../packs/schemas/manifest.js';
import type { Directive, DriftPolicy, Event, Pack, Skill } from '../types.js';

import { formatProfessionError, resolveProfessionDirective } from './profession_resolver.js';

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
  /**
   * T-ASC ASC.3 — aggregated `directive`-level verdicts from every rule
   * that fired. Peer to `contextInjections`; same dispatcher-side flow
   * (aggregate-everywhere, surface-via-prompt_submit). The UserPromptSubmit
   * hook bin serializes the array as a fenced JSON block under a
   * `⛔ DIRECTIVE` marker inside the same `additionalContext` envelope key
   * (no new envelope keys — Claude Code 2.x doesn't reliably honor unknown
   * ones).
   *
   * Block-verdict + directive COEXIST identically to inject_context: a
   * block emitted by a LATER rule still raises exitCode 2, but directives
   * emitted by EARLIER rules still surface on stdout so the agent sees
   * both the next-action handoff and the block message.
   */
  directives: Directive[];
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

// ---------------------------------------------------------------------------
// CU.2 — skill-unload wiring helpers.
//
// `when_to_load` / `unloads_when` are `unknown[]` on the runtime `Skill` type
// (the YAML schema validates them at load; the runtime view stays loose — see
// types.ts). We parse them through the canonical Zod schemas here, dropping any
// malformed entry rather than throwing, so a single bad matcher/condition
// degrades that one entry, never the whole dispatch.
// ---------------------------------------------------------------------------

/** Parse a skill's `when_to_load` (loose `unknown[]`) into typed matchers; drop malformed. */
function parseWhenToLoad(raw: readonly unknown[]): Matcher[] {
  const out: Matcher[] = [];
  for (const r of raw) {
    const parsed = Matcher.safeParse(r);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Parse a skill's `unloads_when` (loose `unknown[]`) into typed conditions; drop malformed. */
function parseUnloadsWhen(raw: readonly unknown[]): UnloadCondition[] {
  const out: UnloadCondition[] = [];
  for (const r of raw) {
    const parsed = UnloadCondition.safeParse(r);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * The per-skill unload gate decision (pure, testable). A DYNAMIC skill is
 * skipped this event ⟺ it has a tick AND `shouldUnload(unloads_when, tick)`
 * fires. FAIL-SAFE = default-LOADED: a missing tick (`undefined`) NEVER
 * skips — silently skipping a gate skill because its tick read failed would
 * be a drift hole. Pinned skills never reach this function.
 */
/**
 * IDF.4 — activation_scope dispatch routing.
 *
 * Per-pack `activation_scope:` (v0.6 §4.5 restored by IDF.1 schema) gates
 * whether the dispatcher should walk a pack's skills at all in the current
 * context. Distinct axis from existing `scope:` (which is layering
 * precedence — universal→domain→specialty→workflow→project).
 *
 * 5-case semantics (per T-IDENTITY-FOUNDATION L7):
 *   - 'project'  → applies when current cwd matches project context
 *   - 'user'     → always applies (per-user globally)
 *   - 'hybrid'   → both project AND user signals must apply
 *   - 'team'     → ships INERT — never fires until team-mode lands.
 *                  Packs declaring this scope are silently dormant; users
 *                  shipping team packs today should know this.
 *   - 'global'   → effectively == 'user' today; distinguishing requires
 *                  multi-user infrastructure (post-v1).
 */
export interface DispatchScopeCtx {
  /** True when current cwd matches the pack's project context (today: always true when discovery loaded the pack at all). */
  inProject: boolean;
  /** Always true today; placeholder for future team/multi-user infrastructure. */
  isUserSession: boolean;
}

/**
 * LL.3 — inbound_channel trigger filter. Honors optional `channel:` literal
 * (matched against the scheme prefix of `event.channelUri`) and optional
 * `sender_pattern` regex (matched against `event.sender`). Empty/absent
 * fields are accept-all per back-compat. Malformed regex → no match.
 */
interface InboundChannelTrigger {
  kind: 'inbound_channel';
  channel?: string;
  sender_pattern?: string;
}

export function inboundChannelTriggerMatches(
  trigger: InboundChannelTrigger,
  event: Extract<Event, { kind: 'inbound_channel' }>,
): boolean {
  if (trigger.channel !== undefined && trigger.channel.length > 0) {
    const m = /^(telegram|slack|discord):\/\//.exec(event.channelUri);
    const platform = m === null ? null : m[1];
    if (platform !== trigger.channel) return false;
  }
  if (trigger.sender_pattern !== undefined && trigger.sender_pattern.length > 0) {
    let re: RegExp;
    try {
      re = new RegExp(trigger.sender_pattern);
    } catch {
      return false;
    }
    if (!re.test(event.sender)) return false;
  }
  return true;
}

export function activationScopeApplies(scope: ActivationScope, ctx: DispatchScopeCtx): boolean {
  switch (scope) {
    case 'project':
      return ctx.inProject;
    case 'user':
      return ctx.isUserSession;
    case 'hybrid':
      return ctx.inProject && ctx.isUserSession;
    case 'team':
      return false;
    case 'global':
      return ctx.isUserSession;
  }
}

export function shouldSkillUnload(skill: Skill, tick: TickState | undefined): boolean {
  if (tick === undefined) return false; // fail-safe: no tick → stay loaded
  const conditions = parseUnloadsWhen(skill.unloads_when);
  if (conditions.length === 0) return false; // no exit conditions → never unloads
  return shouldUnload(conditions, tick);
}

/**
 * Advance the persisted per-skill ticks for the dynamic skill set ONCE for this
 * event (never per-rule — that would multiply the idle count), then return the
 * set of dynamic skill names to SKIP because their unload condition fired.
 *
 * Reactivation: a dynamic skill whose `when_to_load` freshly matches this event
 * has its tick reset (idle counter restarts from zero) — so a skill that had
 * unloaded re-loads the moment its load condition matches again. A skill with
 * empty `when_to_load` never reactivates here; it simply advances and unloads
 * on its idle/edge conditions.
 */
async function computeUnloadSkips(
  event: Event,
  dynamic: readonly Skill[],
  sessionId: string,
): Promise<{ skip: Set<string>; ticks: SkillTicks }> {
  const dynamicIds = dynamic.map((s) => s.name);
  const reactivated = new Set<string>();
  for (const s of dynamic) {
    if (matchesEvent(parseWhenToLoad(s.when_to_load), event)) reactivated.add(s.name);
  }
  const ticks = await advanceSkillTicks(sessionId, event, dynamicIds, reactivated);
  const skip = new Set<string>();
  for (const s of dynamic) {
    if (shouldSkillUnload(s, ticks[s.name])) skip.add(s.name);
  }
  return { skip, ticks };
}

export async function dispatchEvent(
  event: Event,
  packs: Pack[],
  registry: FunctionRegistry,
  sessionId: string,
  scopeCtx: DispatchScopeCtx = { inProject: true, isUserSession: true },
): Promise<DispatchResult> {
  // Count rules walked across all skills so the marker carries a meaningful
  // signal (rules=0 means dispatch ran but no skill subscribed to this kind;
  // rules=N means N rules were evaluated up to the short-circuit point).
  let rulesWalked = 0;
  // G.4 — aggregate inject_context payloads across every rule in every
  // skill. Kept across the full walk (verdict short-circuit still returns
  // any injections that fired BEFORE the verdict — by-design coexistence).
  const contextInjections: string[] = [];
  // T-ASC ASC.3 — peer to contextInjections. Directives emitted on any
  // event kind aggregate here; only the UserPromptSubmit hook bin actually
  // surfaces them via the additionalContext envelope. Other hook bins
  // discard with a warning (same posture as inject_context).
  const directives: Directive[] = [];
  // Stderr warnings buffer when an `inject_context` (or `directive`) fires
  // on an event kind OTHER than `prompt_submit`. Misconfiguration signal
  // per Phase-2 lock #4.
  let warnBuf = '';

  // CU.2 — skill-unload gate. Partition pinned (universal+preload, resident
  // for the whole session) vs dynamic (subject to `unloads_when`). Advance the
  // persisted dynamic-skill ticks ONCE for this event (before the walk, never
  // per-rule) and compute the set of dynamic skills whose unload condition
  // fired this event. Pinned skills are NEVER gated — they are not even passed
  // to the tick advancer (the contradiction warning is emitted at partition
  // time by `partitionSkills`). A dynamic skill in `unloadSkip` has both its
  // rules suppressed AND its `inject_context` prose dropped (the `continue`
  // below skips the whole rule walk, so nothing it would emit lands).
  const { dynamic } = partitionSkills(packs);
  const dynamicSkillNames = new Set(dynamic.map((d) => d.skill.name));
  const { skip: unloadSkip } = await computeUnloadSkips(
    event,
    dynamic.map((d) => d.skill),
    sessionId,
  );

  // T-ASC ASC.2: per-fire precondition cache. ONE instance per dispatchEvent
  // call (NOT module-level — hook bins are short-lived processes; per-call
  // scope amortizes within one fire across N skills sharing a precondition).
  const requiresCache = new RequiresCache();

  for (const pack of packs) {
    // IDF.4 — activation_scope dispatch routing. `pack.activationScope ??
    // 'project'` covers IDF.1's optional Pack runtime field for test
    // fixtures + back-compat. A scope mismatch (e.g. user-context-only pack
    // when scopeCtx.inProject === false) skips the entire skill walk.
    if (!activationScopeApplies(pack.activationScope ?? 'project', scopeCtx)) continue;
    for (const skill of pack.skills) {
      // CU.2: a DYNAMIC skill whose unload condition fired this event is
      // skipped — its rules don't evaluate and its prose isn't injected.
      // Pinned skills (not in `dynamicSkillNames`) are exempt and always walk.
      if (dynamicSkillNames.has(skill.name) && unloadSkip.has(skill.name)) continue;
      // AUTO.1: skip the skill entirely if no trigger subscribes to this
      // event kind. `skill.triggers` is guaranteed non-empty by the schema
      // (`.min(1)`) — an omitted YAML block defaults to `[{kind: 'tool_call'}]`.
      // Using `.some` rather than `.includes` because each trigger is a
      // discriminated-union object, not a bare string.
      if (!skill.triggers.some((t) => t.kind === event.kind)) continue;
      // LL.3 (2026-05-30) — inbound_channel triggers can carry an
      // optional sender_pattern filter (compiled as JS RegExp at
      // dispatch; malformed → silent skip). When the event is an
      // inbound_channel event and ANY matching-kind trigger has a
      // sender_pattern that doesn't match the event sender, the skill
      // is skipped. Empty sender_pattern → accept-all (back-compat).
      // The channel: literal field (e.g. 'telegram') is also honored:
      // it must match the scheme prefix of event.channelUri.
      if (event.kind === 'inbound_channel') {
        const matchingTriggers = skill.triggers.filter((t) => t.kind === 'inbound_channel');
        const anyMatch = matchingTriggers.some((t) =>
          inboundChannelTriggerMatches(t as InboundChannelTrigger, event),
        );
        if (!anyMatch) continue;
      }
      // T-ASC ASC.2: AND-precondition gate at the dispatcher boundary. Slots
      // AFTER the trigger filter (so a wrong-kind event short-circuits before
      // any stat) and BEFORE the rule walk (so rule-local guards never see a
      // skill that the dispatcher already deactivated). Empty `requires:`
      // trivially holds — back-compat with every Phase 1+ pack. Per L5
      // posture: any non-ENOENT stat error inside the evaluator is treated as
      // engaged (the gate walks rules), never silently disabled.
      if (skill.requires.length > 0) {
        const hold = await skillRequiresHold(skill.requires, sessionId, requiresCache);
        if (!hold) continue;
      }
      for (const rule of skill.rules) {
        // Phase 4: destination_check rules fire on the scheduler tick
        // (`destination_scheduler.ts` → `check_destination` primitive), not
        // through the per-event process walker. Skip them here so the
        // dispatcher only walks track_check processes.
        if (rule.kind === 'destination_check') continue;
        // T-ASC ASC.5: per-rule requires evaluated AFTER skill-level
        // requires and BEFORE walking the process. Same RequiresCache so
        // skill-level + per-rule preconditions stat shared files once per
        // fire. Empty rule.requires trivially holds (back-compat).
        if (rule.requires.length > 0) {
          const hold = await skillRequiresHold(rule.requires, sessionId, requiresCache);
          if (!hold) continue;
        }
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

        // T-ASC ASC.3 — `directive` is a non-blocking terminal RuleResult.
        // Aggregate and continue (mirrors inject_context). Only the
        // UserPromptSubmit hook bin emits these via the envelope; other
        // hook bins warn + drop.
        if (result.kind === 'directive') {
          if (event.kind === 'prompt_submit') {
            // MM.2 (2026-05-30) — validate profession directives against the
            // loaded pack registry + each pack's loaded team.yaml. Invalid
            // directives are DROPPED (not emitted to the agent) + the reason
            // is logged to stderr. Skill + tool directives pass through.
            const na = result.directive.next_action;
            if (na.profession !== undefined) {
              const teamsByPack = new Map<string, NonNullable<Pack['team']>>();
              for (const p of packs) {
                if (p.team !== undefined) teamsByPack.set(p.name, p.team);
              }
              const resolved = resolveProfessionDirective(na, packs, teamsByPack);
              if (!resolved.ok) {
                warnBuf +=
                  `[opensquid] WARN: dropping invalid profession directive — ` +
                  `${formatProfessionError(resolved.reason)} (rule "${rule.id}" in skill ` +
                  `"${skill.name}" pack "${pack.name}")\n`;
                continue;
              }
            }
            directives.push({ ...result.directive, ruleId: rule.id });
          } else {
            warnBuf +=
              `[opensquid] WARN: rule "${rule.id}" in skill "${skill.name}" (pack "${pack.name}") ` +
              `emitted a directive on event kind "${event.kind}"; only "prompt_submit" surfaces ` +
              `directives (drop). Update the skill's triggers: block.\n`;
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
              directives,
            };
          case 'warn':
            emitDispatchMarker(event.kind, rulesWalked, packs.length);
            return {
              exitCode: 0,
              stderr: appendWarn(action.message, warnBuf),
              contextInjections,
              directives,
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
              directives,
            };
        }
      }
    }
  }
  emitDispatchMarker(event.kind, rulesWalked, packs.length);
  return { exitCode: 0, stderr: appendWarn('', warnBuf), contextInjections, directives };
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

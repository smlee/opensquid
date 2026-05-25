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
 * Phase 1 policy: every verdict is funneled through `applyDriftResponse` with
 * the **`block_tool` default policy** (hard-coded here). Pack-declared
 * `drift_response` policies wire in Phase 2+ when the loader exposes a
 * per-rule / per-pack policy map. Locking the default to `block_tool` (rather
 * than `warn`) keeps Phase 1 conservative — a fired rule blocks the tool.
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
import type { Event, Pack } from '../types.js';

export interface DispatchResult {
  exitCode: 0 | 2;
  stderr: string;
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
        };
        const result = await evaluateProcess(rule.process, ctx, registry);
        if (result.kind !== 'verdict') continue;

        // Phase 1: every verdict routes through the `block_tool` default
        // policy. Pack-declared policies wire in Phase 2+ via the loader.
        const action = applyDriftResponse(result.verdict, 'block_tool');
        switch (action.kind) {
          case 'block_tool':
            emitDispatchMarker(event.kind, rulesWalked, packs.length);
            return { exitCode: 2, stderr: action.message };
          case 'warn':
            emitDispatchMarker(event.kind, rulesWalked, packs.length);
            return { exitCode: 0, stderr: action.message };
          case 'halt':
          case 'notify_pause':
            // Phase 1 stub: real halt = Task 1.14; real notify = Task 1.18.
            // Until then, return allow + empty stderr so a future-policy
            // verdict during Phase 1 doesn't accidentally block.
            emitDispatchMarker(event.kind, rulesWalked, packs.length);
            return { exitCode: 0, stderr: '' };
        }
      }
    }
  }
  emitDispatchMarker(event.kind, rulesWalked, packs.length);
  return { exitCode: 0, stderr: '' };
}

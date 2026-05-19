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

export async function dispatchEvent(
  event: Event,
  packs: Pack[],
  registry: FunctionRegistry,
  sessionId: string,
): Promise<DispatchResult> {
  for (const pack of packs) {
    for (const skill of pack.skills) {
      for (const rule of skill.rules) {
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
            return { exitCode: 2, stderr: action.message };
          case 'warn':
            return { exitCode: 0, stderr: action.message };
          case 'halt':
          case 'notify_pause':
            // Phase 1 stub: real halt = Task 1.14; real notify = Task 1.18.
            // Until then, return allow + empty stderr so a future-policy
            // verdict during Phase 1 doesn't accidentally block.
            return { exitCode: 0, stderr: '' };
        }
      }
    }
  }
  return { exitCode: 0, stderr: '' };
}

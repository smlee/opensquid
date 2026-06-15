/**
 * `arm_scope` primitive — the SINGLE owner of the request-type veto on the SCOPE
 * arm (wg-649d80e78e64).
 *
 * The coding-flow has TWO producers of the `scope_start` arm: `enter-scoping`
 * (keyword intent) and `rearm-on-depletion` (the structural re-arm after a track
 * completes). RTC.2 originally gated only `enter-scoping`, so a research/docs turn
 * after a completed track re-armed `scoping` and the pause/commit gates fired on
 * non-coding work. The root cause was the per-producer duplication of the veto —
 * "every producer must remember the gate." This primitive removes that shape: it
 * owns the veto, and BOTH producers route their arm through it, so a research turn
 * can never arm SCOPE and no future producer can reintroduce the bypass.
 *
 * Contract: read the current `request-type` record; if `type === "research"`,
 * no-op (return the unchanged state); otherwise fire `scope_start` (the total
 * `step`, transition guards evaluated through the expression engine like
 * `advance_fsm`). No-op `ok(null)` when the pack ships no `fsm.yaml`. Null-safe:
 * an absent record → `rt?.type` is undefined → arms (backward-compat; in
 * production the deterministic classifier always writes a record before dispatch).
 *
 * Imports from: zod, ../runtime/evaluator/expression, ../runtime/fsm_state,
 *   ../runtime/result, ../runtime/session_state, ./registry.
 * Imported by: src/functions/index.ts (registry wiring via bootstrap).
 */

import { z } from 'zod';

import { evalCondition } from '../runtime/evaluator/expression/index.js';
import { advanceFsmState, readFsmState } from '../runtime/fsm_state.js';
import { ok } from '../runtime/result.js';
import { readRequestType } from '../runtime/session_state.js';

import type { FunctionRegistry } from './registry.js';

const EmptyArgs = z.object({}).strict();

export function registerArmScopeFunction(registry: FunctionRegistry): void {
  registry.register({
    name: 'arm_scope',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 3,
    execute: async (_args, ctx) => {
      if (ctx.packFsm === undefined) return ok(null);
      const rt = await readRequestType(ctx.sessionId);
      if (rt?.type === 'research') {
        // Research/understand-only turn → never arm SCOPE (else the pause/commit
        // gates fire on non-coding work). Return the unchanged state.
        return ok(await readFsmState(ctx.sessionId, ctx.packId, ctx.packFsm));
      }
      const result = await advanceFsmState(
        ctx.sessionId,
        ctx.packId,
        ctx.packFsm,
        'scope_start',
        new Date().toISOString(),
        (expr) => evalCondition(expr, ctx.bindings),
      );
      return ok(result.next);
    },
  });
}

/**
 * T-PACK-FSM-STANDARDIZATION slice A3b — `read_fsm_state` / `advance_fsm`.
 *
 * Make a pack's declared lifecycle FSM (`Pack.fsm`, threaded as `ctx.packFsm`)
 * usable from its OWN rules — closing the loop so a pack drives + gates on its
 * machine without any change to the generic interpreter:
 *
 *   - `read_fsm_state()` → the current state string. Bind via `as` and gate:
 *       - call: read_fsm_state
 *         as: st
 *       - call: verdict
 *         if: st == "researching"
 *         args: { level: block, message: "finish research first" }
 *   - `advance_fsm({ event })` → fire an event; advances ONLY along a declared
 *     transition (the total `step`), guards (`when`) evaluated through the
 *     expression engine over the current bindings, then persists. Returns the
 *     new state (== current when the event matched nothing — total/no-op).
 *
 * Both return `null` when the pack ships no `fsm.yaml` (`ctx.packFsm`
 * undefined) — a pack without a lifecycle simply has nothing to read/advance.
 */
import { z } from 'zod';

import { evalCondition } from '../runtime/evaluator/expression/index.js';
import { advanceFsmState, readFsmState, readFsmStateRaw } from '../runtime/fsm_state.js';
import { ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// Optional `pack`: read ANOTHER pack's lifecycle state (cross-pack gating).
// Omitted → the calling pack's own FSM (via ctx.packFsm).
const ReadFsmStateArgs = z.object({ pack: z.string().min(1).optional() }).strict();
const AdvanceFsmArgs = z.object({ event: z.string().min(1) }).strict();

export function registerFsmFunctions(registry: FunctionRegistry): void {
  registry.register({
    name: 'read_fsm_state',
    argSchema: ReadFsmStateArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 1,
    execute: async ({ pack }, ctx) => {
      // Cross-pack read: another pack's persisted state string (null if unstarted).
      if (pack !== undefined) return ok(await readFsmStateRaw(ctx.sessionId, pack));
      // Own pack: full read with the threaded FSM (defaults to initial).
      if (ctx.packFsm === undefined) return ok(null);
      return ok(await readFsmState(ctx.sessionId, ctx.packId, ctx.packFsm));
    },
  });

  registry.register({
    name: 'advance_fsm',
    argSchema: AdvanceFsmArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 2,
    execute: async ({ event }, ctx) => {
      if (ctx.packFsm === undefined) return ok(null);
      const now = new Date().toISOString();
      const result = await advanceFsmState(
        ctx.sessionId,
        ctx.packId,
        ctx.packFsm,
        event,
        now,
        (expr) => evalCondition(expr, ctx.bindings),
      );
      return ok(result.next);
    },
  });
}

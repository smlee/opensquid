/**
 * `procedure_pre_inject` primitive (wg-7f6225238a27).
 *
 * The per-pack, agent-facing OPERATING PROCEDURE injector — the positive "how to do this work
 * so it passes the gates first-try" companion to `rubric_pre_inject`'s quality BAR. Modeled on
 * `rubric_pre_inject` (prompt_submit gate, inject_context shape) but GENERAL: it reads the
 * calling pack's procedure from the threaded `ctx.packProcedure` (`Pack.procedure`, loaded from
 * the pack's `procedure.md`) and self-gates GENERICALLY — NO hardcoded pack id:
 *
 *   - if the pack ships an FSM (`ctx.packFsm`): inject while the pack is ENGAGED, i.e. its
 *     current state ≠ `fsm.initial` (the whole active lifecycle — for coding-flow that is every
 *     non-idle state, covering SCOPE→AUTHOR→EXECUTE, since gate-fighting happens in EXECUTE too);
 *   - if the pack ships no FSM: engaged whenever loaded (the rule firing means the pack is active).
 *
 * The calling skill rule is UNCONDITIONAL (`- call: procedure_pre_inject`), matching
 * `inject-rubric`'s shape — the engaged-state set is derived from the pack's own `fsm.initial`,
 * never duplicated into YAML. Advisory: never blocks; injects nothing when not engaged / no
 * procedure. The size cap lives at load time (`loadOptionalProcedure`), so an over-cap procedure
 * arrives here as `undefined` and simply injects nothing.
 */

import { z } from 'zod';

import { readFsmStateRaw } from '../runtime/fsm_state.js';
import { ok } from '../runtime/result.js';

import { buildInjectContext } from './inject_context.js';
import type { FunctionRegistry } from './registry.js';

const EmptyArgs = z.object({}).strict();

export function registerProcedurePreInject(registry: FunctionRegistry): void {
  registry.register({
    name: 'procedure_pre_inject',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 2,
    execute: async (_args, ctx) => {
      if (ctx.event.kind !== 'prompt_submit') return ok(null);
      if (ctx.packProcedure === undefined) return ok(null);
      // Generic engagement gate (no hardcoded pack id).
      if (ctx.packFsm !== undefined) {
        const st = await readFsmStateRaw(ctx.sessionId, ctx.packId);
        if (st === null || st === ctx.packFsm.initial) return ok(null);
      }
      const header = `## ${ctx.packId} — operating procedure (follow this to pass the gates first-try)`;
      return ok(buildInjectContext(`${header}\n\n${ctx.packProcedure}`));
    },
  });
}

/**
 * FAC-CUT.2 — the production `GuardEvaluator` for the behavior-FSM (flowchart) path.
 *
 * A v2 gate is a guard (a boolean CONDITION) + an action AUTHORED ON THE STATE
 * (`GateState.on_fail: block|halt` — the 4-action model; applied by the event-driven gate dispatch).
 * So the runtime guard evaluator is a PURE PREDICATE: it resolves a
 * guard ref to its `if:`-expression in the pack `guards` registry and returns the boolean via the
 * existing `evalCondition` engine. No verdict levels, no drift_response policy, no `applyDriftResponse`
 * — that v1 machinery is migration-time (wg-8b195b49b60a), not the runtime's.
 *
 * Used by the event-driven `V2ObservedActor` gate path.
 */
import { evalCondition } from '../evaluator/expression/index.js';
import type { GuardCtx, GuardEvaluator } from './gate_dispatch.js';

export class RegistryGuardEvaluator implements GuardEvaluator {
  /** `exprs` = the compiled pack's `guardExprs` (guard ref → `if:`-expression). */
  constructor(private readonly exprs: ReadonlyMap<string, string>) {}

  eval(guardRef: string, ctx: GuardCtx): boolean {
    const expr = this.exprs.get(guardRef);
    if (expr === undefined) {
      // fail-LOUD: a dangling ref escaped compile-time validation — a bug, never a silent pass.
      throw new Error(`FAC-CUT.2: no guard expression for ref '${guardRef}'`);
    }
    // `ctx` is the bindings Map at the eval site (supplied at the FAC-CUT.4 integration). A malformed or
    // over-limit expression fails CLOSED inside evalCondition (warns, returns false) → the guard fails →
    // the gate blocks via its on_fail (the safe default).
    return evalCondition(expr, ctx as Map<string, unknown>);
  }
}

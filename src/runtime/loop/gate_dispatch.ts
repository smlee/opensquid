/**
 * GATE-DISPATCH — the pure, registry-free per-state guard dispatch (FAC-CUT.5b.1).
 *
 * Extracted VERBATIM from `LoopDriver` (`driver.ts:127-154,188-206`): the SOUND, guard-driven gate/decision
 * dispatch (the part the 2026-06-18 drift audit confirmed is correct — vs the OUTER completion-pull
 * `runExecutor`/`runToTerminal`, which stays in `driver.ts` as the retire-candidate). Made standalone by
 * taking `fsm` + `guards` as parameters (no `this.deps.registry`, no executor/floor) so BOTH the driver-RUN
 * `LoopDriver` AND the EVENT-DRIVEN `V2ObservedActor` reuse one implementation — no duplication.
 *
 * Spec: loop/docs/tasks/T-fac-cut-5b1-v2-conformance-actor.md.
 */
import { fromFlat, soleState, step, type Fsm } from '../fsm.js';
import type { StateMeta } from '../../packs/compile_v2.js';

/** Opaque guard-evaluation context, threaded through to the injected evaluator. */
export type GuardCtx = unknown;

/** Injected guard evaluator (reuses `evaluator.ts` at integration; pure boolean here). */
export interface GuardEvaluator {
  eval(guardRef: string, ctx: GuardCtx): boolean | Promise<boolean>;
}

/** The total result of one dispatch — a discriminated union (no implicit `{next?, outcome?}` ambiguity). */
export type DriverStep =
  | { kind: 'advance'; next: string; notice?: string } // notice = a non-blocking `warn` surfaced on proceed (kernel.ts:36)
  | { kind: 'action'; action: 'block' | 'halt'; message: string } // gate fail → self-continue/halt (ENFORCE, stop)
  | { kind: 'outcome'; outcome: 'shipped' | 'wedge'; reason?: string };

/** Compute the next state for a named event via the reused engine; a missing transition is a compiler bug. */
export function transitionOn(fsm: Fsm, state: string, event: string): string {
  const r = step(fromFlat(fsm), new Set([state]), event);
  if (!r.transitioned) {
    throw new Error(
      `gate_dispatch: no '${event}' transition from '${state}' (compiler invariant violated)`,
    );
  }
  return soleState(r.next);
}

/** The NAMED event an executor/gate/sub_flow state emits to advance; the compiler guarantees it is set. */
export function emitOf(state: string, m: StateMeta): string {
  if (m.emits === undefined) {
    throw new Error(
      `gate_dispatch: state '${state}' (kind '${m.kind}') has no emit event (compiler invariant)`,
    );
  }
  return m.emits;
}

/** gate: guard pass ⇒ emit `on_pass_emits` (advance); fail ⇒ the `on_fail` ACTION (warn = advance+notice;
 *  block/halt = ENFORCE, stop). Verbatim from `LoopDriver.runGate` (`driver.ts:127-140`). */
export async function evalGate(
  fsm: Fsm,
  state: string,
  m: StateMeta,
  guards: GuardEvaluator,
  ctx: GuardCtx,
): Promise<DriverStep> {
  const ok = await guards.eval(m.guard ?? '', ctx);
  if (ok) return { kind: 'advance', next: transitionOn(fsm, state, emitOf(state, m)) };
  const onFail = m.onFail ?? { action: 'block' as const, message: `gate '${state}' failed` };
  if (onFail.action === 'warn') {
    return {
      kind: 'advance',
      next: transitionOn(fsm, state, emitOf(state, m)),
      notice: onFail.message,
    };
  }
  return { kind: 'action', action: onFail.action, message: onFail.message };
}

/** decision: first-match branch by declared order emits that branch's event; the total `else` is the
 *  fallback. No match + no else ⇒ throw (totality). Verbatim from `LoopDriver.runDecision`
 *  (`driver.ts:142-154`); `StateV2.refine()` guarantees exactly one `else` (last). */
export async function evalDecision(
  fsm: Fsm,
  state: string,
  m: StateMeta,
  guards: GuardEvaluator,
  ctx: GuardCtx,
): Promise<DriverStep> {
  for (const b of m.branches ?? []) {
    if ('else' in b) return { kind: 'advance', next: transitionOn(fsm, state, b.emits) };
    if (await guards.eval(b.guard, ctx))
      return { kind: 'advance', next: transitionOn(fsm, state, b.emits) };
  }
  throw new Error(
    'gate_dispatch: decision state had no matching branch and no else (totality violated)',
  );
}

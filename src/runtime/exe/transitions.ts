/**
 * EXE.1 — FSM-as-primary transition evaluation (T-fsm-actor-runtime §EXE.1).
 *
 * The V1 control structure was a global `packs × skills × rules` walk
 * (`dispatch.ts:284–538`): every fire re-walked every rule of every skill of
 * every pack. EXE.1 makes the FSM primary: control is "evaluate the CURRENT
 * state's guarded transitions" — only the current state's outgoing edges are
 * considered, never a global walk. The loop driver (LOOP.1) runs the per-kind
 * BEHAVIOR (spawn executor / recurse sub_flow); this module is the pure
 * TRANSITION decision for one state + the multi-pack arbitration that composes
 * several connected packs as orthogonal regions.
 *
 * Multi-pack arbitration (preserved from the V1 scope-precedence + first-blocking
 * -wins): connected packs are orthogonal regions, evaluated in precedence order;
 * the FIRST region that yields a blocking action short-circuits (its block/halt
 * wins); non-blocking advances accumulate. This is the orthogonal-region
 * composition that replaces the V1 walk's pack/skill precedence loop.
 *
 * Reuses `fsm.ts` `step` over the NAMED events each state emits (`meta[state].emits` /
 * a decision branch's `emits`) and the injected `GuardEvaluator` (the same guard-eval
 * LOOP.1 uses; at integration this is `evaluator.ts` with its dead durable/memo branches
 * pruned — those are EVALUATOR branches, the `durable/` store itself is reused).
 */
import { fromFlat, soleState, step } from '../fsm.js';
import type { CompiledPack } from '../../packs/compile_v2.js';
import type { GuardCtx, GuardEvaluator } from '../loop/driver.js';

/** A gate-fail action (block/halt + the self-continue message; KERN.1 applies it). */
export interface TransitionAction {
  action: 'block' | 'halt';
  message: string;
}

/** The transition decision for ONE state: advance to `next`, OR emit a gate action, OR neither (terminal). */
export interface TransitionResult {
  next?: string;
  action?: TransitionAction;
}

/** Compute the next state for a named event; a missing transition is a compiler-invariant bug. */
function stepTo(compiled: CompiledPack, state: string, event: string): string {
  if (compiled.fsm === undefined) {
    // EXE.1 only evaluates a behavior pack's transitions; a conformance/foundation pack has no fsm.
    throw new Error(`EXE.1: cannot step a non-behavior pack (no fsm) from '${state}'`);
  }
  const r = step(fromFlat(compiled.fsm), new Set([state]), event);
  if (!r.transitioned) {
    throw new Error(
      `EXE.1: no '${event}' transition from '${state}' (compiler invariant violated)`,
    );
  }
  return soleState(r.next);
}

/** The NAMED event a gate/executor/sub_flow state emits; the compiler guarantees it is set. */
function emitOf(state: string, kind: string, emits: string | undefined): string {
  if (emits === undefined) {
    throw new Error(
      `EXE.1: state '${state}' (kind '${kind}') has no emit event (compiler invariant)`,
    );
  }
  return emits;
}

/**
 * Evaluate ONLY the current state's outgoing transitions (no global walk).
 * - gate: eval the guard → pass emits `on_pass_emits` (routed), fail yields the `on_fail` action.
 * - decision: first-match by declared order emits that branch's event (routed), with the total `else`.
 * - executor / sub_flow: the loop driver runs the behavior, then the transition fires on the NAMED
 *   completion `event` the driver emits.
 * - terminal: no outgoing transition.
 */
export async function evaluateTransition(
  compiled: CompiledPack,
  state: string,
  event: string,
  ctx: GuardCtx,
  guards: GuardEvaluator,
): Promise<TransitionResult> {
  const m = compiled.meta[state];
  if (m === undefined) throw new Error(`EXE.1: no meta for state '${state}'`); // total: unknown state is a bug
  switch (m.kind) {
    case 'gate': {
      const ok = await guards.eval(m.guard ?? '', ctx);
      if (ok) return { next: stepTo(compiled, state, emitOf(state, m.kind, m.emits)) };
      return { action: m.onFail ?? { action: 'block', message: `gate '${state}' failed` } };
    }
    case 'decision': {
      for (const b of m.branches ?? []) {
        if ('else' in b) return { next: stepTo(compiled, state, b.emits) }; // total fallback (one, last)
        if (await guards.eval(b.guard, ctx)) return { next: stepTo(compiled, state, b.emits) }; // first-match
      }
      throw new Error(
        `EXE.1: decision '${state}' had no matching branch and no else (totality violated)`,
      );
    }
    case 'terminal':
      return {}; // no outgoing transition
    case 'executor':
    case 'sub_flow':
      // the loop driver runs the behavior; the transition fires on the NAMED completion event it emits
      return { next: stepTo(compiled, state, event) };
  }
}

/** One connected pack as an orthogonal region: its compiled FSM + its current state. */
export interface Region {
  compiled: CompiledPack;
  state: string;
}

/** The arbitrated outcome over all connected regions. */
export interface Arbitration {
  /** the first blocking region's action (precedence-ordered, first-blocking-wins) — short-circuits. */
  blocked?: TransitionAction;
  /** non-blocking advances, in region precedence order (applied as orthogonal-region transitions). */
  advances: { region: Region; next: string }[];
}

/**
 * Arbitrate the current-state transitions across connected packs (orthogonal regions),
 * preserving the V1 scope-precedence + first-blocking-wins: evaluate in declared order; the
 * FIRST region to block short-circuits (its action wins); otherwise all advances accumulate.
 */
export async function arbitrate(
  regions: Region[],
  event: string,
  ctx: GuardCtx,
  guards: GuardEvaluator,
): Promise<Arbitration> {
  const advances: { region: Region; next: string }[] = [];
  for (const region of regions) {
    // precedence = declared order
    const res = await evaluateTransition(region.compiled, region.state, event, ctx, guards);
    if (res.action) return { blocked: res.action, advances }; // first-blocking-wins → short-circuit
    if (res.next !== undefined) advances.push({ region, next: res.next });
  }
  return { advances };
}

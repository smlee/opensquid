/**
 * LOOP.1 — the generic loop driver (T-fsm-actor-runtime §LOOP.1, Phase 2).
 *
 * Steps a connected execution FSM by reading `CompiledPack.meta` per state. The driver
 * has NO behavior of its own — ALL behavior lives in the pack FSM; the driver only
 * dispatches on the 5 state kinds and composes the substrate guarantees:
 *
 *   executor → resolve `executor(S)` (agent registry: ensure-connected, else FAIL-CLOSED —
 *              never a wrong-fallback), run the inner tool-loop under the Progress floor
 *              (GUARD.1) + the completion guard; transition only when the guard HOLDS
 *              (agent-claims-done-but-guard-fails ⇒ keep looping — anti-self-grading).
 *   gate     → evaluate the guard: pass ⇒ emit `on_pass_emits` (advance), fail ⇒ the `on_fail` ACTION
 *              (block/halt + self-continue; KERN.1 owns the message).
 *   decision → first-match branch by declared order emits that branch's event (guarded, total `else`).
 *   sub_flow → recurse into the nested FSM (ISOLATED — no parent-state bleed); on its
 *              terminal, the parent emits its event (advance).
 *   terminal → SHIPPED / WEDGE.
 *
 * Generalizes the ralph per-item lap (`ralph/orchestrator.ts:64`) into a per-state step;
 * the work-item source is the work-graph (wired at the outer loop). Transitions use the
 * reused `fsm.ts` `step` over the NAMED event each state emits (`meta[state].emits` /
 * a decision branch's `emits`) — the same author-named vocabulary as the live `advance_fsm`.
 */
import { type Fsm } from '../fsm.js';
import type { CompiledPack, StateMeta } from '../../packs/compile_v2.js';
import { ProgressFloor, type ToolObservation } from '../guard/progress_floor.js';
import { evaluateCompletion } from '../guard/connector.js';
// FAC-CUT.5b.1: the sound per-state guard dispatch is extracted to gate_dispatch.ts (registry-free, reused
// by V2ObservedActor too). The OUTER completion-pull (runExecutor/runToTerminal) stays here (retire-candidate).
import {
  evalGate,
  evalDecision,
  transitionOn,
  emitOf,
  type GuardCtx,
  type GuardEvaluator,
  type DriverStep,
} from './gate_dispatch.js';
// Re-export for the driver's existing importers (back-compat — these moved to gate_dispatch.ts).
export type { GuardCtx, GuardEvaluator, DriverStep };

/** One observable step the executor's inner tool-loop produced. */
export interface InnerStep {
  observation: ToolObservation; // the tool call just made (feeds the Progress floor)
  completionGuardHeld: boolean; // does the executor-state completion guard hold after this step?
}

/** An executor's inner tool-loop, modeled as a pull of steps. `null` = the executor gave up. */
export interface Executor {
  next(): Promise<InnerStep | null>;
}

/** Agent registry: resolve an executor name to a connected executor, or FAIL-CLOSED. */
export interface ExecutorRegistry {
  /** ensure-connected → return the executor; THROW if it can't be connected (never wrong-fallback). */
  ensureExecutor(name: string): Promise<Executor>;
}

export interface LoopDeps {
  registry: ExecutorRegistry;
  guards: GuardEvaluator;
  /** factory so each executor inner-loop gets its OWN Progress floor (counters are per-run). */
  makeFloor?: () => ProgressFloor;
}

export class LoopDriver {
  constructor(
    private readonly compiled: CompiledPack,
    private readonly deps: LoopDeps,
  ) {}

  /** The behavior FSM — present by construction (the driver only ever runs a behavior pack;
   *  a conformance/foundation pack compiles with no `fsm` and never reaches the driver). */
  private get fsm(): Fsm {
    if (this.compiled.fsm === undefined) {
      throw new Error('LOOP.1: driver requires a behavior pack (compiled pack has no fsm)');
    }
    return this.compiled.fsm;
  }

  /** Advance one state. The state's `meta.kind` selects the dispatch; the driver adds no behavior. */
  async step(state: string, ctx: GuardCtx = undefined): Promise<DriverStep> {
    const m = this.compiled.meta[state];
    if (m === undefined) throw new Error(`LOOP.1: no meta for state '${state}'`); // total: unknown state is a bug
    switch (m.kind) {
      case 'executor':
        return this.runExecutor(state, m);
      case 'gate':
        return this.runGate(state, m, ctx);
      case 'decision':
        return this.runDecision(state, m, ctx);
      case 'sub_flow':
        return this.runSubFlow(state, m, ctx);
      case 'terminal':
        return { kind: 'outcome', outcome: m.outcome ?? 'wedge' };
    }
  }

  private async runExecutor(state: string, m: StateMeta): Promise<DriverStep> {
    // ensure-connected → fail-closed. A throw here is the CORRECT failure (no wrong-fallback executor).
    const exec = await this.deps.registry.ensureExecutor(m.executor ?? state);
    const floor = (this.deps.makeFloor ?? (() => new ProgressFloor()))();
    for (;;) {
      const inner = await exec.next();
      if (inner === null) {
        // the executor gave up without the completion guard holding → wedge (never silently advance)
        return {
          kind: 'outcome',
          outcome: 'wedge',
          reason: `executor '${m.executor ?? state}' exhausted`,
        };
      }
      const floorAction = floor.observe(inner.observation);
      const verdict = evaluateCompletion({
        completionGuardHeld: inner.completionGuardHeld,
        floorAction,
      });
      if (verdict.kind === 'release')
        return { kind: 'advance', next: transitionOn(this.fsm, state, emitOf(state, m)) };
      if (verdict.kind === 'break')
        return { kind: 'outcome', outcome: 'wedge', reason: verdict.reason };
      // continue: the completion guard hasn't held yet (incl. claims-done-but-guard-fails) — keep looping
    }
  }

  // FAC-CUT.5b.1: the gate/decision dispatch is extracted to gate_dispatch.ts (registry-free, reused by
  // V2ObservedActor). These delegate — same logic, one source.
  private runGate(state: string, m: StateMeta, ctx: GuardCtx): Promise<DriverStep> {
    return evalGate(this.fsm, state, m, this.deps.guards, ctx);
  }

  private runDecision(state: string, m: StateMeta, ctx: GuardCtx): Promise<DriverStep> {
    return evalDecision(this.fsm, state, m, this.deps.guards, ctx);
  }

  private async runSubFlow(state: string, m: StateMeta, ctx: GuardCtx): Promise<DriverStep> {
    // HAR.1 — ISOLATION BY CONSTRUCTION: resolve the named child machine from the FLAT `flows` registry
    // and run it on a FRESH LoopDriver whose `this.compiled`/`this.fsm`/`this.meta` ARE the child — so
    // step/transitionOn/meta-dispatch resolve only the child's states (no parent-state bleed).
    const child = this.compiled.flows?.[m.flow ?? ''];
    if (child === undefined) {
      throw new Error(
        `LOOP.1: sub_flow '${state}' -> flow '${m.flow ?? ''}' has no compiled nested machine`,
      );
    }
    const outcome = await new LoopDriver(child, this.deps).runToTerminal(ctx);
    if (outcome === 'shipped') {
      return { kind: 'advance', next: transitionOn(this.fsm, state, emitOf(state, m)) };
    }
    return { kind: 'outcome', outcome: 'wedge', reason: `sub_flow '${m.flow ?? state}' wedged` };
  }

  /** Run THIS driver's machine from its OWN initial state to a terminal, returning the outcome.
   *  (A child sub-flow runs on its own LoopDriver, so `this.fsm`/`this.step` are the child's — HAR.1.) */
  async runToTerminal(ctx: GuardCtx): Promise<'shipped' | 'wedge'> {
    let cur = this.fsm.initial;
    // a bounded walk: the FSM is finite + acyclic-to-terminal by construction; the cap is a backstop.
    for (let guardCount = 0; guardCount < 10_000; guardCount++) {
      const r = await this.step(cur, ctx);
      if (r.kind === 'outcome') return r.outcome;
      if (r.kind === 'action') return 'wedge'; // a sub-flow gate that blocks/halts wedges the sub-flow
      cur = r.next;
    }
    return 'wedge'; // backstop: a non-terminating sub-flow is a wedge, never an infinite loop
  }
  // emitOf / transitionOn moved to gate_dispatch.ts (FAC-CUT.5b.1) — imported above + called with this.fsm.
}

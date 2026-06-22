/**
 * V2-OBSERVED-ACTOR (FAC-CUT.5b.1) — the EVENT-DRIVEN runtime for an OBSERVED v2 cartridge.
 *
 * coding-flow is OBSERVED: the agent works in its own harness and opensquid watches hook events. On a
 * trigger-matching observation, `receive` runs the cartridge's current state through the SOUND, reused
 * gate/decision dispatch (`gate_dispatch.ts` — NOT the drifted completion-pull `LoopDriver`), chaining
 * auto-evaluated `decision`s to the next gate AWAIT-POINT, and returns `Effect[]` (the host applies them).
 * PURE: no bus, no registry, no I/O — replayable/testable (the actor-port contract, port.ts:6-10).
 *
 * Implements `ActorPort` DIRECTLY (not `extends BaseActor`): `receive` is ASYNC (the guard eval is async via
 * the shared `evalGate`), and `BaseActor.receive` is sync (`port.ts:57`) — a sync method cannot be overridden
 * by an async one, so the small lifecycle (state/restart/toWedge) is reimplemented here.
 *
 * The audit-running + ctx-binding + effect-application (publish gate_action via kernel.applyAction, inject the
 * message, persist state, register the actor) is the HOST SUPPLY — FAC-CUT.5b.2. This slice is the pure actor.
 *
 * Spec: loop/docs/tasks/T-fac-cut-5b1-v2-conformance-actor.md.
 */
import type { ActorAddr, Envelope, MessageKind } from '../bus/types.js';
import type { ActorPort, ActorState, Effect } from '../actor/port.js';
import type { Fsm } from '../fsm.js';
import type { LoadedPackV2 } from '../../packs/loader_v2.js';
import type { StateMeta } from '../../packs/compile_v2.js';
import { RegistryGuardEvaluator } from './guard_evaluator.js';
import { evalGate, evalDecision, type GuardEvaluator } from './gate_dispatch.js';

// Backstop (mirrors driver.ts runToTerminal): a non-terminating decision chain is a wedge, never a spin.
const MAX_CHAIN = 10_000;

export class V2ObservedActor implements ActorPort {
  readonly addr: ActorAddr;
  readonly fsm: Fsm;
  state: ActorState;
  private readonly guards: GuardEvaluator;
  private readonly meta: Record<string, StateMeta>;

  constructor(addr: ActorAddr, loaded: LoadedPackV2) {
    const fsm = loaded.compiled.fsm;
    if (fsm === undefined) {
      throw new Error('V2ObservedActor: pack has no fsm (not a behavior-form cartridge)');
    }
    this.addr = addr;
    this.fsm = fsm;
    this.state = { current: fsm.initial, history: [] };
    this.guards = new RegistryGuardEvaluator(loaded.compiled.guardExprs ?? new Map());
    this.meta = loaded.compiled.meta;
  }

  /** The observed events the cartridge's gates react to (the union of every gate's `trigger`). */
  subscribe(): MessageKind[] {
    const kinds = new Set<MessageKind>();
    for (const m of Object.values(this.meta)) {
      for (const t of m.trigger ?? []) kinds.add(t as MessageKind);
    }
    return [...kinds];
  }

  /**
   * Event-driven step: a gate fires ONLY on its declared observed `trigger` (the await-point). When it does,
   * run the reused dispatch over the current state and chain auto `decision`s to the next gate / terminal /
   * enforce. Returns `Effect[]`; the host (5b.2) applies them.
   */
  async receive(env: Envelope): Promise<Effect[]> {
    let cur = this.state.current;
    const ctx = (env.payload as { ctx?: unknown }).ctx;
    const entry = this.meta[cur];
    if (entry?.kind === 'gate' && !(entry.trigger ?? []).includes(env.kind)) {
      return []; // await-point: this observation is not what the current gate waits for
    }
    const effects: Effect[] = [];
    for (let chain = 0; chain < MAX_CHAIN; chain++) {
      const m = this.meta[cur];
      if (m === undefined) throw new Error(`V2ObservedActor: no meta for state '${cur}'`);
      if (m.kind !== 'gate' && m.kind !== 'decision') break; // terminal at rest / executor (not observed-reachable)
      const sr =
        m.kind === 'gate'
          ? await evalGate(this.fsm, cur, m, this.guards, ctx)
          : await evalDecision(this.fsm, cur, m, this.guards, ctx);
      if (sr.kind === 'action') {
        effects.push(gateFail(cur, sr.action, sr.message)); // block | halt: ENFORCE, stay
        break;
      }
      if (sr.kind !== 'advance') break; // `outcome` is never produced by evalGate/evalDecision — defensive
      // advance (gate pass, gate warn, or decision branch): write the new state + the transition.
      effects.push({ kind: 'write_state', state: sr.next });
      effects.push({
        kind: 'emit',
        to: 'topic:transition',
        messageKind: 'transition',
        payload: { from: cur, to: sr.next },
      });
      if (sr.notice !== undefined) effects.push(gateFail(cur, 'warn', sr.notice)); // warn = advance + nudge
      this.state.history.push(cur);
      cur = sr.next;
      if (this.meta[cur]?.kind === 'gate') break; // reached the next await-point — stop until its trigger
    }
    this.state.current = cur;
    return effects;
  }

  /** Re-entrant reset to the initial state (the supervisor restarts a crashed actor — SUP.1). */
  restart(): void {
    this.state = { current: this.fsm.initial, history: [] };
  }

  /** Park the actor as wedged (supervisor calls this on restart-exhaustion). */
  toWedge(reason: string): void {
    this.state.wedged = reason;
  }
}

/**
 * The gate-fail Effect the HOST (FAC-CUT.5b.2) applies via `kernel.applyAction(action, failureType, {
 * [failureType]: message }, {bus, from})` → publishes the canonical `gate_action{action, failureType}` (INV2)
 * + returns the `GateEffect` (exitCode/message/verdict) to inject. The actor stays PURE (no bus); this payload
 * is the bridge data (the v2 inline `onFail.message` → the kernel's failure-typed API).
 */
function gateFail(state: string, action: 'warn' | 'block' | 'halt', message: string): Effect {
  return {
    kind: 'emit',
    to: 'topic:gate_action',
    messageKind: 'gate_action',
    payload: { action, failureType: state, message },
  };
}

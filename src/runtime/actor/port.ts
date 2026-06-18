/**
 * PORT.1 — the universal actor contract (T-fsm-actor-runtime §PORT.1).
 *
 * Every component (substrate + pack) is an FSM actor implementing `ActorPort`.
 * `receive` is PURE: it maps an inbound envelope to an FSM event, runs the reused
 * `fsm.ts` `step`, and returns `Effect[]` (outbound emits · a state-write · a
 * side-effect request) — it performs no I/O itself, so it is replayable + testable.
 * The host (daemon) applies the effects (persisting state via `fsm_state.ts`,
 * publishing emits on the bus). `BaseActor` wraps the step + transition-emit; a
 * subclass supplies `addr`/`fsm`/`subscribe`/`eventFor`.
 */
import type { ActorAddr, Envelope, MessageKind } from '../bus/types.js';
import { step, type Fsm } from '../fsm.js';

export type Effect =
  | { kind: 'emit'; to: string; messageKind: MessageKind; payload: unknown }
  | { kind: 'write_state'; state: string }
  | { kind: 'side_effect'; run: () => Promise<void> };

export interface ActorState {
  current: string;
  history: string[];
  wedged?: string; // set by toWedge(reason) when the supervisor exhausts restarts (SUP.1)
}

export interface ActorPort {
  readonly addr: ActorAddr;
  readonly fsm: Fsm;
  state: ActorState;
  receive(env: Envelope): Effect[] | Promise<Effect[]>;
  subscribe(): MessageKind[]; // which message kinds this actor consumes
  /** Re-entrant reset to the initial state (the supervisor restarts a crashed actor — SUP.1). */
  restart(): void;
  /** Park the actor (supervisor calls this on restart-exhaustion — SUP.1). */
  toWedge(reason: string): void;
  // Optional lifecycle hooks (property-fn types) — the host calls `actor.onConnect?.()`. Most actors
  // have no connect/disconnect logic, so these are optional rather than forced empty overrides.
  onConnect?: () => void;
  onDisconnect?: () => void;
}

export abstract class BaseActor implements ActorPort {
  state: ActorState;

  constructor(
    readonly addr: ActorAddr,
    readonly fsm: Fsm,
  ) {
    this.state = { current: fsm.initial, history: [] };
  }

  /** Map an inbound envelope to an FSM event name, or null to ignore it. */
  protected abstract eventFor(env: Envelope): string | null;

  abstract subscribe(): MessageKind[];

  receive(env: Envelope): Effect[] {
    const event = this.eventFor(env);
    if (event === null) return [];
    const from = this.state.current;
    const result = step(this.fsm, from, event);
    if (!result.transitioned) return []; // total: a non-matching event is an explicit stay (no effects)
    this.state.history.push(from);
    this.state.current = result.next;
    return [
      { kind: 'write_state', state: result.next },
      {
        kind: 'emit',
        to: 'topic:transition',
        messageKind: 'transition',
        payload: { from, to: result.next, on: event },
      },
    ];
  }

  /** Re-entrant: reset to the initial state (never throws — the supervisor relies on it). */
  restart(): void {
    this.state = { current: this.fsm.initial, history: [] };
  }

  /** Park the actor as wedged (supervisor calls this on restart-exhaustion). */
  toWedge(reason: string): void {
    this.state.wedged = reason;
  }
  // onConnect / onDisconnect are optional hooks (ActorPort) — a subclass implements them only if needed.
}

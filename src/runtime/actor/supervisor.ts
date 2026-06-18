/**
 * SUP.1 — supervisor + crash isolation (T-fsm-actor-runtime §SUP.1).
 *
 * Wraps an actor's `receive`: a throw is caught and ISOLATED (never propagates to the bus or
 * siblings). One-for-one restart policy — restart only the failed actor, bounded by `maxRestarts`
 * in a rolling window, with backoff; on restart-exhaustion the actor is parked (`toWedge`) and a
 * `transition → wedge` is published (a crash deterministically becomes a wedge, never a silent drop).
 * Grounded in Erlang/OTP supervision (one-for-one + max-restarts-in-window).
 */
import type { Bus } from '../bus/bus.js';
import type { Envelope } from '../bus/types.js';
import type { ActorPort, Effect } from './port.js';

export interface RestartPolicy {
  maxRestarts: number;
  windowMs: number;
  backoffMs: (attempt: number) => number;
}

export const defaultPolicy: RestartPolicy = {
  maxRestarts: 3,
  windowMs: 60_000,
  backoffMs: (n) => Math.min(2000 * 2 ** (n - 1), 30_000),
};

/** Injected for testability (avoids real wall-clock + real sleeps in tests). */
export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class Supervisor {
  constructor(
    private readonly bus: Bus,
    private readonly policy: RestartPolicy = defaultPolicy,
    private readonly clock: Clock = realClock,
  ) {}

  /** A guarded `receive`: catches throws, restarts (bounded + backoff), wedges on exhaustion. */
  guard(actor: ActorPort): (env: Envelope) => Promise<Effect[]> {
    let restarts: number[] = [];
    return async (env: Envelope): Promise<Effect[]> => {
      try {
        return await actor.receive(env);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const now = this.clock.now();
        restarts = restarts.filter((t) => now - t < this.policy.windowMs);
        restarts.push(now);
        if (restarts.length > this.policy.maxRestarts) {
          actor.toWedge(reason); // exhausted → park (a crash deterministically becomes a wedge)
          this.bus.publish({
            from: 'supervisor',
            to: 'topic:transition',
            kind: 'transition',
            payload: { actor: actor.addr, to: 'wedge', reason },
          });
          return [];
        }
        await this.clock.sleep(this.policy.backoffMs(restarts.length));
        actor.restart(); // re-entrant; the crashed envelope is dropped, the actor is fresh for the next
        return [];
      }
    };
  }
}

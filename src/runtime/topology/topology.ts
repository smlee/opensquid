/**
 * TOPO.1 — the Topology FSM + live ActorRegistry (T-fsm-actor-runtime §TOPO.1).
 *
 * The Topology's STATE is the connected-actor set; its only transitions are
 * `connect` / `disconnect` — both TOTAL (a rejected guard or an unknown addr is
 * an explicit no-op, never a throw). This replaces the resolve-once
 * `realPacksPromise` (`bootstrap.ts:374`): instead of every short-lived hook
 * re-reading `active.json`, a long-lived runtime (DAEMON.1) owns ONE registry and
 * the `opensquid pack` toggle drives `connect`/`disconnect` at runtime — packs are
 * hot-swappable without a restart.
 *
 * INVARIANT (atomic connect): the registry contains an actor IFF it is fully
 * connected. `connect` performs the 4 atomic steps (subscribe + grant state-read +
 * arm guardrails + bind `skills(initial)`) inside the actor's `onConnect` hook; if
 * that throws, the actor is rolled back out of the registry and parked (`toWedge`)
 * — a partial connect is a wedge, never a half-registered actor.
 *
 * `disconnect` persists the actor's final state (via `onDisconnect`) BEFORE
 * unregistering, so a later genesis reconcile (GR.1) can resume it cleanly.
 *
 * Grounded in Erlang/OTP topology supervision (a supervisor owns a live child set)
 * and gstack's string-keyed registry; uses the bus's `topology` MessageKind (BUS.1).
 */
import type { Bus } from '../bus/bus.js';
import type { ActorAddr } from '../bus/types.js';
import type { ActorPort } from '../actor/port.js';

/** The live connected-actor set — the Topology's state, keyed by address. */
export class ActorRegistry {
  private readonly actors = new Map<ActorAddr, ActorPort>();

  get(addr: ActorAddr): ActorPort | undefined {
    return this.actors.get(addr);
  }
  has(addr: ActorAddr): boolean {
    return this.actors.has(addr);
  }
  addrs(): ActorAddr[] {
    return [...this.actors.keys()];
  }
  set(addr: ActorAddr, actor: ActorPort): void {
    this.actors.set(addr, actor);
  }
  delete(addr: ActorAddr): boolean {
    return this.actors.delete(addr);
  }
  get size(): number {
    return this.actors.size;
  }
}

export class Topology {
  constructor(
    private readonly bus: Bus,
    readonly registry: ActorRegistry = new ActorRegistry(),
  ) {}

  /** The current state: the set of connected actor addresses. */
  connected(): ActorAddr[] {
    return this.registry.addrs();
  }
  isConnected(addr: ActorAddr): boolean {
    return this.registry.has(addr);
  }

  /**
   * Gated Connect transition. `guard` (e.g. `() => setup_complete` for chat) is a
   * total predicate: a falsy guard rejects the transition (returns false, no-op).
   * On accept, `onConnect` runs the 4 atomic steps; a throw rolls the actor back
   * out of the registry and wedges it (a partial connect is a wedge).
   */
  connect(actor: ActorPort, guard?: () => boolean): boolean {
    if (guard && !guard()) return false; // gated transition rejected — explicit no-op
    if (this.registry.has(actor.addr)) return true; // idempotent: already connected
    this.registry.set(actor.addr, actor); // tentative — rolled back on a partial connect
    try {
      actor.onConnect?.(); // subscribe + grant state-read + arm guardrails + bind skills(initial)
    } catch (err) {
      this.registry.delete(actor.addr); // rollback: registered IFF fully connected
      actor.toWedge(err instanceof Error ? err.message : String(err));
      this.bus.publish({
        from: 'topology',
        to: 'topic:topology',
        kind: 'topology',
        payload: { connect: actor.addr, wedged: true },
      });
      return false;
    }
    this.bus.publish({
      from: 'topology',
      to: 'topic:topology',
      kind: 'topology',
      payload: { connect: actor.addr },
    });
    return true;
  }

  /**
   * Disconnect transition (total: an unknown addr is a no-op). Persists the actor's
   * final state via `onDisconnect` (unsubscribe + revoke + unload skills + persist)
   * BEFORE unregistering, so genesis reconcile (GR.1) can resume it.
   */
  disconnect(addr: ActorAddr): void {
    const actor = this.registry.get(addr);
    if (!actor) return; // total: disconnecting an absent actor is an explicit no-op
    actor.onDisconnect?.(); // unsubscribe + revoke + unload skills + persist final state (before unregister)
    this.registry.delete(addr);
    this.bus.publish({
      from: 'topology',
      to: 'topic:topology',
      kind: 'topology',
      payload: { disconnect: addr },
    });
  }
}

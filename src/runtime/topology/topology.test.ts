/** TOPO.1 — topology FSM + live registry. */
import { describe, expect, it } from 'vitest';

import { Bus } from '../bus/bus.js';
import type { Envelope, MessageKind } from '../bus/types.js';
import type { ActorPort, Effect } from '../actor/port.js';
import { ActorRegistry, Topology } from './topology.js';

// A minimal actor with observable lifecycle hooks for connect/disconnect assertions.
function makeActor(
  addr: string,
  opts: { onConnectThrows?: boolean } = {},
): ActorPort & { connected: boolean; disconnected: boolean; wedgedReason?: string } {
  return {
    addr,
    fsm: { initial: 'a', states: ['a'], transitions: [] },
    state: { current: 'a', history: [] },
    connected: false,
    disconnected: false,
    receive(): Effect[] {
      return [];
    },
    subscribe(): MessageKind[] {
      return ['tool_call'];
    },
    restart(): void {
      /* test actor: no FSM to reset */
    },
    toWedge(reason: string): void {
      this.wedgedReason = reason;
    },
    onConnect(): void {
      if (opts.onConnectThrows) throw new Error('partial-connect boom');
      this.connected = true;
    },
    onDisconnect(): void {
      this.disconnected = true;
    },
  };
}

const topoEvents = (bus: Bus): Envelope[] =>
  bus.since(0).events.filter((e) => e.kind === 'topology');

describe('ActorRegistry (TOPO.1)', () => {
  it('tracks the connected set by address', () => {
    const r = new ActorRegistry();
    const a = makeActor('act');
    r.set('act', a);
    expect(r.has('act')).toBe(true);
    expect(r.get('act')).toBe(a);
    expect(r.addrs()).toEqual(['act']);
    expect(r.size).toBe(1);
    expect(r.delete('act')).toBe(true);
    expect(r.has('act')).toBe(false);
  });
});

describe('Topology (TOPO.1)', () => {
  it('connect with a passing guard: registered + onConnect fired + a topology event', () => {
    const bus = new Bus();
    const topo = new Topology(bus);
    const a = makeActor('pack:demo');
    expect(topo.connect(a, () => true)).toBe(true);
    expect(topo.isConnected('pack:demo')).toBe(true);
    expect(a.connected).toBe(true);
    expect(topoEvents(bus).at(-1)).toMatchObject({ payload: { connect: 'pack:demo' } });
  });

  it('connect chat with setup_complete=false: gated out — not connected, no onConnect', () => {
    const bus = new Bus();
    const topo = new Topology(bus);
    const chat = makeActor('chat');
    const setupComplete = false;
    expect(topo.connect(chat, () => setupComplete)).toBe(false);
    expect(topo.isConnected('chat')).toBe(false);
    expect(chat.connected).toBe(false);
    expect(topoEvents(bus)).toHaveLength(0);
  });

  it('a partial connect (onConnect throws) rolls back + wedges (atomic invariant)', () => {
    const bus = new Bus();
    const topo = new Topology(bus);
    const a = makeActor('pack:bad', { onConnectThrows: true });
    expect(topo.connect(a)).toBe(false);
    expect(topo.isConnected('pack:bad')).toBe(false); // rolled back out of the registry
    expect(a.wedgedReason).toMatch(/partial-connect/);
    expect(topoEvents(bus).at(-1)).toMatchObject({
      payload: { connect: 'pack:bad', wedged: true },
    });
  });

  it('connect is idempotent: a second connect of a live actor is a no-op true', () => {
    const topo = new Topology(new Bus());
    const a = makeActor('pack:demo');
    expect(topo.connect(a)).toBe(true);
    a.connected = false; // would flip back if onConnect ran again
    expect(topo.connect(a)).toBe(true);
    expect(a.connected).toBe(false); // onConnect did NOT re-fire
  });

  it('disconnect persists final state (onDisconnect) BEFORE unregister + emits a topology event', () => {
    const bus = new Bus();
    const topo = new Topology(bus);
    const a = makeActor('pack:demo');
    topo.connect(a);
    topo.disconnect('pack:demo');
    expect(a.disconnected).toBe(true);
    expect(topo.isConnected('pack:demo')).toBe(false);
    expect(topoEvents(bus).at(-1)).toMatchObject({ payload: { disconnect: 'pack:demo' } });
  });

  it('disconnect of an absent actor is a total no-op (no throw, no event)', () => {
    const bus = new Bus();
    const topo = new Topology(bus);
    expect(() => topo.disconnect('ghost')).not.toThrow();
    expect(topoEvents(bus)).toHaveLength(0);
  });

  it('hot-swap: an active.json toggle drives connect then disconnect with no restart', () => {
    const topo = new Topology(new Bus());
    const a = makeActor('pack:demo');
    topo.connect(a); // active.json add → Connect
    expect(topo.connected()).toEqual(['pack:demo']);
    topo.disconnect('pack:demo'); // active.json remove → Disconnect
    expect(topo.connected()).toEqual([]);
    const b = makeActor('pack:demo'); // re-add → re-Connect (fresh actor, no process restart)
    expect(topo.connect(b)).toBe(true);
    expect(topo.connected()).toEqual(['pack:demo']);
  });
});

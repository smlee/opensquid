/** SUP.1 — supervisor + crash isolation. */
import { describe, expect, it, vi } from 'vitest';

import { Bus } from '../bus/bus.js';
import type { Envelope, MessageKind } from '../bus/types.js';
import type { ActorPort, Effect } from './port.js';
import { Supervisor, type Clock, type RestartPolicy } from './supervisor.js';

const env: Envelope = { seq: 1, from: 'x', to: 'topic:t', kind: 'tool_call', payload: {}, ts: 0 };

// A controllable actor: `failTimes` throws on the first N receives, then succeeds.
function makeActor(failTimes: number): ActorPort & { restarts: number; wedgedReason?: string } {
  let calls = 0;
  return {
    addr: 'act',
    fsm: { initial: 'a', states: ['a'], transitions: [] },
    state: { current: 'a', history: [] },
    restarts: 0,
    receive(): Effect[] {
      calls += 1;
      if (calls <= failTimes) throw new Error(`boom ${calls}`);
      return [{ kind: 'write_state', state: 'a' }];
    },
    subscribe(): MessageKind[] {
      return ['tool_call'];
    },
    restart(): void {
      this.restarts += 1;
    },
    toWedge(reason: string): void {
      this.wedgedReason = reason;
    },
  };
}

const fastClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };
const policy: RestartPolicy = { maxRestarts: 3, windowMs: 60_000, backoffMs: () => 0 };

describe('Supervisor (SUP.1)', () => {
  it('passes a non-throwing receive straight through', async () => {
    const guarded = new Supervisor(new Bus(), policy, fastClock).guard(makeActor(0));
    expect(await guarded(env)).toEqual([{ kind: 'write_state', state: 'a' }]);
  });

  it('isolates a throw: caught, actor restarted, returns [] (no propagation)', async () => {
    const actor = makeActor(1);
    const guarded = new Supervisor(new Bus(), policy, fastClock).guard(actor);
    await expect(guarded(env)).resolves.toEqual([]); // does NOT throw
    expect(actor.restarts).toBe(1);
  });

  it('wedges + publishes a transition on restart-exhaustion (one-for-one)', async () => {
    const actor = makeActor(99); // always throws
    const bus = new Bus();
    const guarded = new Supervisor(bus, policy, fastClock).guard(actor);
    for (let i = 0; i < 4; i++) await guarded(env); // 4 throws > maxRestarts(3)
    expect(actor.wedgedReason).toMatch(/boom/);
    const wedgeEvents = bus.since(0).events.filter((e) => e.kind === 'transition');
    expect(wedgeEvents.at(-1)).toMatchObject({ payload: { actor: 'act', to: 'wedge' } });
  });

  it('applies backoff between restarts (via the injected clock)', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const clock: Clock = { now: () => 0, sleep };
    const guarded = new Supervisor(new Bus(), { ...policy, backoffMs: (n) => n * 10 }, clock).guard(
      makeActor(1),
    );
    await guarded(env);
    expect(sleep).toHaveBeenCalledWith(10);
  });
});

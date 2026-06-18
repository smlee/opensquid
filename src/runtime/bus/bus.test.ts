/** BUS.1 — the typed envelope bus (pub/sub + replay + subscriber isolation). */
import { describe, expect, it } from 'vitest';

import { Bus } from './bus.js';
import type { Envelope } from './types.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0)); // drain queueMicrotask callbacks

describe('Bus (BUS.1)', () => {
  it('assigns a strictly-increasing seq', () => {
    const bus = new Bus();
    const a = bus.publish({ from: 'x', to: 'topic:t', kind: 'tool_call', payload: 1 });
    const b = bus.publish({ from: 'x', to: 'topic:t', kind: 'tool_call', payload: 2 });
    expect(b.seq).toBe(a.seq + 1);
  });

  it('delivers only envelopes matching the subscriber filter', async () => {
    const bus = new Bus();
    const got: Envelope[] = [];
    bus.subscribe(
      (e) => e.kind === 'transition',
      (e) => got.push(e),
    );
    bus.publish({ from: 'x', to: 'topic:t', kind: 'tool_call', payload: 1 }); // filtered out
    bus.publish({ from: 'x', to: 'topic:t', kind: 'transition', payload: 2 }); // matches
    await flush();
    expect(got).toHaveLength(1);
    expect(got[0]?.kind).toBe('transition');
  });

  it('isolates a throwing subscriber — publish returns and other subscribers still fire', async () => {
    const bus = new Bus();
    const got: number[] = [];
    bus.subscribe(
      () => true,
      () => {
        throw new Error('bad subscriber');
      },
    );
    bus.subscribe(
      () => true,
      (e) => got.push(e.seq),
    );
    const env = bus.publish({ from: 'x', to: 'topic:t', kind: 'lap', payload: 0 });
    expect(env.seq).toBe(1); // publish completed despite the throwing subscriber
    await flush();
    expect(got).toEqual([1]); // the good subscriber still received it
  });

  it('replays via since(seq) with gap-detection', () => {
    const bus = new Bus(2); // tiny window to force a gap
    bus.publish({ from: 'x', to: 'topic:t', kind: 'lap', payload: 1 });
    bus.publish({ from: 'x', to: 'topic:t', kind: 'lap', payload: 2 });
    bus.publish({ from: 'x', to: 'topic:t', kind: 'lap', payload: 3 }); // evicts seq 1
    const { events, gap } = bus.since(0);
    expect(gap).toBe(true);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
    expect(bus.since(2)).toMatchObject({ gap: false });
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new Bus();
    const got: number[] = [];
    const off = bus.subscribe(
      () => true,
      (e) => got.push(e.seq),
    );
    off();
    bus.publish({ from: 'x', to: 'topic:t', kind: 'lap', payload: 0 });
    await flush();
    expect(got).toEqual([]);
  });
});

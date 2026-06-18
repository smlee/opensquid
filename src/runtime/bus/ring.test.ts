/** BUS.1 — CircularBuffer (ported from gstack buffers.ts). */
import { describe, expect, it } from 'vitest';

import { CircularBuffer } from './ring.js';

describe('CircularBuffer (BUS.1)', () => {
  it('retains all entries within capacity; since(0) returns them in order, no gap', () => {
    const r = new CircularBuffer<string>(5);
    ['a', 'b', 'c'].forEach((x) => r.push(x));
    expect(r.size).toBe(3);
    expect(r.totalAdded).toBe(3);
    expect(r.since(0)).toEqual({ events: ['a', 'b', 'c'], gap: false });
  });

  it('evicts the oldest on overflow; since(0) reports a gap + returns the retained window', () => {
    const r = new CircularBuffer<string>(3);
    ['a', 'b', 'c', 'd'].forEach((x) => r.push(x)); // 'a' evicted
    expect(r.size).toBe(3);
    expect(r.totalAdded).toBe(4);
    expect(r.since(0)).toEqual({ events: ['b', 'c', 'd'], gap: true });
  });

  it('since(cursor) inside the window returns only entries after it, no gap', () => {
    const r = new CircularBuffer<string>(3);
    ['a', 'b', 'c', 'd'].forEach((x) => r.push(x)); // retained: b(2) c(3) d(4)
    expect(r.since(3)).toEqual({ events: ['d'], gap: false });
    expect(r.since(4)).toEqual({ events: [], gap: false });
  });

  it('empty buffer → no events, no gap', () => {
    expect(new CircularBuffer<string>(3).since(0)).toEqual({ events: [], gap: false });
  });
});

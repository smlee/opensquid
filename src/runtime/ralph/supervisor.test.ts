/**
 * GR.3 — superviseLap: bounded respawn, terminal-passthrough, cost accumulation, no silent death.
 */
import { describe, expect, it } from 'vitest';

import { superviseLap, type LapResult } from './supervisor.js';

const opts = (maxRetries: number) => ({
  maxRetries,
  backoffMs: () => 0,
  heartbeat: () => undefined,
  sleep: () => Promise.resolve(), // no real waiting in tests
});

// A run that yields the given sequence of results (the last repeats if exhausted).
const sequence = (...results: LapResult[]) => {
  let i = 0;
  return (): Promise<LapResult> => {
    const r = results[Math.min(i++, results.length - 1)];
    if (r === undefined) throw new Error('sequence exhausted');
    return Promise.resolve(r);
  };
};

describe('superviseLap', () => {
  it('returns a terminal SHIPPED immediately (no retry)', async () => {
    let calls = 0;
    const r = await superviseLap(() => {
      calls++;
      return Promise.resolve({ kind: 'SHIPPED', costUsd: 0.01 });
    }, opts(3));
    expect(r).toEqual({ kind: 'SHIPPED', costUsd: 0.01, inputTokens: 0, outputTokens: 0 });
    expect(calls).toBe(1);
  });

  it('retries on CRASH then succeeds, accumulating cost across attempts', async () => {
    let heartbeats = 0;
    const r = await superviseLap(
      sequence(
        { kind: 'CRASH', costUsd: 0.02 },
        { kind: 'CRASH', costUsd: 0.02 },
        { kind: 'SHIPPED', costUsd: 0.05 },
      ),
      { ...opts(3), heartbeat: () => heartbeats++ },
    );
    expect(r.kind).toBe('SHIPPED');
    expect(r.costUsd).toBeCloseTo(0.09); // both crashes + the ship are billed
    expect(heartbeats).toBe(3);
  });

  it('exhausts bounded retries → typed HUMAN_REQUIRED{UNRECOVERABLE_WEDGE} (never silent)', async () => {
    const r = await superviseLap(sequence({ kind: 'CRASH', costUsd: 0.01 }), opts(2));
    expect(r).toEqual({
      kind: 'HUMAN_REQUIRED',
      reason: 'UNRECOVERABLE_WEDGE',
      costUsd: 0.03,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('a HUMAN_REQUIRED outcome is terminal — not retried', async () => {
    let calls = 0;
    const r = await superviseLap(() => {
      calls++;
      return Promise.resolve<LapResult>({
        kind: 'HUMAN_REQUIRED',
        reason: 'SCOPE_FORK',
        costUsd: 0.04,
      });
    }, opts(3));
    expect(r.kind).toBe('HUMAN_REQUIRED');
    expect(calls).toBe(1);
  });

  it('a thrown run is treated as CRASH and retried (bounded)', async () => {
    let calls = 0;
    const r = await superviseLap(() => {
      calls++;
      if (calls < 2) throw new Error('boom');
      return Promise.resolve<LapResult>({ kind: 'SHIPPED', costUsd: 0.01 });
    }, opts(3));
    expect(r.kind).toBe('SHIPPED');
    expect(calls).toBe(2);
  });

  it('TIMEOUT is retryable, exhausting to UNRECOVERABLE_WEDGE', async () => {
    const r = await superviseLap(sequence({ kind: 'TIMEOUT', costUsd: 0 }), opts(1));
    expect(r).toEqual({
      kind: 'HUMAN_REQUIRED',
      reason: 'UNRECOVERABLE_WEDGE',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('LSF.5 — accumulates input/output tokens across retries (a crashed attempt still burned tokens)', async () => {
    const r = await superviseLap(
      sequence(
        { kind: 'CRASH', costUsd: 0.02, inputTokens: 100, outputTokens: 20 },
        { kind: 'SHIPPED', costUsd: 0.05, inputTokens: 300, outputTokens: 80 },
      ),
      opts(3),
    );
    expect(r.kind).toBe('SHIPPED');
    expect(r.inputTokens).toBe(400); // both attempts' input tokens summed
    expect(r.outputTokens).toBe(100); // both attempts' output tokens summed
    expect(r.costUsd).toBeCloseTo(0.07);
  });
});

/**
 * DURABLE.3 — evaluator memoization wrap tests.
 *
 * Covers the integration between the evaluator's durable-wrap (DURABLE.2)
 * and the MemoCache (DURABLE.3). These tests exercise the BEHAVIOR the
 * runtime caller sees end-to-end, not just the cache primitive:
 *
 *   1. Memo HIT short-circuits a primitive that ALREADY ran in a DIFFERENT
 *      run_id with the same inputs. The primitive is NOT invoked; a new
 *      checkpoint row is still written for the new run so DURABLE.4's
 *      resumer sees the step as completed.
 *
 *   2. Memo only fires for primitives with `memoizable: true`. A
 *      non-memoizable durable primitive (e.g. a stateful state.set) MUST
 *      re-invoke on every call even when args are identical.
 *
 *   3. Singleflight through the evaluator path: 100 concurrent
 *      `evaluateProcess` calls against the same runId+memoizable step → 1
 *      primitive invocation.
 *
 *   4. Memoizable-but-not-durable: a primitive declared `memoizable: true,
 *      durable: false` still caches identical inputs, no checkpoint side
 *      effect.
 *
 *   5. Errored results are NOT memoized — the next call retries.
 *
 *   6. `ttlForFn` resolver is invoked per primitive name; entries respect
 *      the TTL it returns.
 */

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type EvalCtx, type FunctionDef, FunctionRegistry } from '../functions/registry.js';

import { CheckpointStore } from './durable/checkpoint_store.js';
import { MemoCache } from './durable/memo_cache.js';
import { evaluateProcess } from './evaluator.js';
import { err, ok } from './result.js';
import type { Event, ProcessStep } from './types.js';

import type { Client } from '@libsql/client';

function createTestCtx(overrides: Partial<EvalCtx> = {}): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'test-session',
    packId: 'test-pack',
    ...overrides,
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

let client: Client;
let store: CheckpointStore;
let cache: MemoCache;
beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  store = new CheckpointStore(client);
  cache = new MemoCache(client);
  await store.init();
  await cache.init();
});
afterEach(() => {
  client.close();
});

function memoizableDurable(name: string, execute: FunctionDef['execute']): FunctionDef {
  return {
    name,
    argSchema: z.object({}).passthrough(),
    execute,
    durable: true,
    memoizable: true,
    costEstimateMs: 100,
  };
}

function durableOnly(name: string, execute: FunctionDef['execute']): FunctionDef {
  return {
    name,
    argSchema: z.object({}).passthrough(),
    execute,
    durable: true,
    memoizable: false,
    costEstimateMs: 100,
  };
}

function memoizableOnly(name: string, execute: FunctionDef['execute']): FunctionDef {
  return {
    name,
    argSchema: z.object({}).passthrough(),
    execute,
    durable: false,
    memoizable: true,
    costEstimateMs: 100,
  };
}

describe('evaluator + MemoCache — memo hit short-circuits across runs', () => {
  it('second run with same inputs but different runId hits the memo, not the primitive', async () => {
    let invocations = 0;
    const echo = memoizableDurable('echo', (args) => {
      invocations += 1;
      return Promise.resolve(ok((args as { value: string }).value));
    });
    const reg = new FunctionRegistry();
    reg.register(echo);

    const steps: ProcessStep[] = [{ call: 'echo', args: { value: 'X' }, as: 'out' }];

    // Run #1 — primitive executes, cache populates.
    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-A' },
      memo: { cache },
    });
    expect(invocations).toBe(1);

    // Run #2 — DIFFERENT runId but SAME (fn, args). Memo hits; primitive
    // does NOT run again. A checkpoint row is still written for run-B.
    const ctx2 = createTestCtx();
    await evaluateProcess(steps, ctx2, reg, {
      checkpoint: { store, runId: 'run-B' },
      memo: { cache },
    });
    expect(invocations).toBe(1);
    expect(ctx2.bindings.get('out')).toBe('X');

    const rowsB = await store.fetchRun('run-B');
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.status).toBe('completed');
    expect(rowsB[0]?.outputs).toBe('X');
  });
});

describe('evaluator + MemoCache — memoizable-only enforcement', () => {
  it('non-memoizable durable primitive re-invokes on identical args (no caching)', async () => {
    let invocations = 0;
    const stateSet = durableOnly('state_set', () => {
      invocations += 1;
      return Promise.resolve(ok('written'));
    });
    const reg = new FunctionRegistry();
    reg.register(stateSet);

    const steps: ProcessStep[] = [{ call: 'state_set', args: { key: 'x', value: 1 } }];

    // Run #1 — primitive runs, durable checkpoint written, NO memo write.
    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-A' },
      memo: { cache },
    });
    expect(invocations).toBe(1);

    // Different runId, identical args — memo MUST NOT short-circuit (the
    // primitive is non-memoizable, so the cache was never populated).
    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-B' },
      memo: { cache },
    });
    expect(invocations).toBe(2);

    // Cache contains zero rows for state_set.
    const rs = await client.execute({
      sql: 'SELECT COUNT(*) AS n FROM memo_cache WHERE fn = ?',
      args: ['state_set'],
    });
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(0);
  });

  it('non-durable non-memoizable primitive never touches the cache', async () => {
    let invocations = 0;
    const cheap: FunctionDef = {
      name: 'cheap',
      argSchema: z.object({}).passthrough(),
      execute: () => {
        invocations += 1;
        return Promise.resolve(ok('v'));
      },
      durable: false,
      memoizable: false,
      costEstimateMs: 0.1,
    };
    const reg = new FunctionRegistry();
    reg.register(cheap);

    const steps: ProcessStep[] = [{ call: 'cheap' }];

    // Run twice — every call re-invokes; no cache write.
    await evaluateProcess(steps, createTestCtx(), reg, { memo: { cache } });
    await evaluateProcess(steps, createTestCtx(), reg, { memo: { cache } });
    expect(invocations).toBe(2);

    const rs = await client.execute('SELECT COUNT(*) AS n FROM memo_cache');
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(0);
  });
});

describe('evaluator + MemoCache — singleflight under concurrency', () => {
  it('100 concurrent evaluateProcess calls on the same key → 1 primitive invocation', async () => {
    let invocations = 0;
    const slow = memoizableDurable('slow_llm', async () => {
      invocations += 1;
      // Yield so all 100 callers queue up before the first compute resolves.
      await new Promise((r) => setTimeout(r, 10));
      return ok('classified');
    });
    const reg = new FunctionRegistry();
    reg.register(slow);

    // Each call uses a fresh checkpoint runId (so the checkpoint-prefetch
    // returns empty) but the SAME (fn, args) — so they all collide on the
    // same memo key. Singleflight should dedup them down to one primitive
    // call.
    const steps: ProcessStep[] = [{ call: 'slow_llm', args: { prompt: 'hello' }, as: 'label' }];

    const racers = Array.from({ length: 100 }, (_, i) =>
      evaluateProcess(steps, createTestCtx(), reg, {
        checkpoint: { store, runId: `race-${i}` },
        memo: { cache },
      }),
    );
    const results = await Promise.all(racers);

    expect(invocations).toBe(1);
    // Every caller saw the same `classified` value bound to `label`.
    expect(results).toHaveLength(100);
    // Every run wrote exactly one checkpoint row; the value matches the
    // single primitive's output for the first run, and the memo's cached
    // value for the other 99.
    for (let i = 0; i < 100; i++) {
      const rows = await store.fetchRun(`race-${i}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outputs).toBe('classified');
    }
  });
});

describe('evaluator + MemoCache — memoizable-but-not-durable', () => {
  it('caches across calls without writing checkpoints', async () => {
    let invocations = 0;
    const memoOnly = memoizableOnly('pure_helper', () => {
      invocations += 1;
      return Promise.resolve(ok('cached'));
    });
    const reg = new FunctionRegistry();
    reg.register(memoOnly);

    const steps: ProcessStep[] = [{ call: 'pure_helper', args: { x: 1 } }];

    // No checkpoint option — pure memoization path.
    await evaluateProcess(steps, createTestCtx(), reg, { memo: { cache } });
    await evaluateProcess(steps, createTestCtx(), reg, { memo: { cache } });
    expect(invocations).toBe(1);

    // No checkpoint rows written.
    const rs = await client.execute('SELECT COUNT(*) AS n FROM checkpoints');
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(0);

    // But the memo row exists.
    const memoRs = await client.execute('SELECT COUNT(*) AS n FROM memo_cache');
    expect(Number(memoRs.rows[0]?.n ?? 0)).toBe(1);
  });
});

describe('evaluator + MemoCache — errored results are not memoized', () => {
  it('errored primitive does not populate the cache; next call retries', async () => {
    let invocations = 0;
    const flaky = memoizableDurable('flaky', () => {
      invocations += 1;
      if (invocations === 1) {
        return Promise.resolve(err({ kind: 'runtime' as const, message: 'transient' }));
      }
      return Promise.resolve(ok('eventually-ok'));
    });
    const reg = new FunctionRegistry();
    reg.register(flaky);

    const steps: ProcessStep[] = [{ call: 'flaky', args: { x: 1 }, as: 'val' }];

    // Run #1 — errors. Cache must NOT remember the failure.
    const r1 = await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-A' },
      memo: { cache },
    });
    expect(r1.kind).toBe('error');

    // Run #2, different runId — primitive must run again (errors aren't
    // cached) and this time succeed.
    const ctx2 = createTestCtx();
    const r2 = await evaluateProcess(steps, ctx2, reg, {
      checkpoint: { store, runId: 'run-B' },
      memo: { cache },
    });
    expect(invocations).toBe(2);
    expect(r2).toEqual({ kind: 'no_verdict' });
    expect(ctx2.bindings.get('val')).toBe('eventually-ok');

    // Now the cache HAS the success — third run hits it.
    const ctx3 = createTestCtx();
    await evaluateProcess(steps, ctx3, reg, {
      checkpoint: { store, runId: 'run-C' },
      memo: { cache },
    });
    expect(invocations).toBe(2);
    expect(ctx3.bindings.get('val')).toBe('eventually-ok');
  });
});

describe('evaluator + MemoCache — ttlForFn resolver', () => {
  it('per-primitive TTL resolver controls cache lifetime', async () => {
    let now = 1_000_000;
    const cache2 = new MemoCache(client, { nowMs: () => now });
    await cache2.init();

    let invocations = 0;
    const fast = memoizableDurable('fast_llm', () => {
      invocations += 1;
      return Promise.resolve(ok('classified'));
    });
    const reg = new FunctionRegistry();
    reg.register(fast);

    const steps: ProcessStep[] = [{ call: 'fast_llm', args: { prompt: 'p' }, as: 'label' }];

    // TTL of 30s for fast_llm. Resolver maps name → ms.
    const ttlForFn = (fn: string): number | undefined => (fn === 'fast_llm' ? 30_000 : undefined);

    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-A' },
      memo: { cache: cache2, ttlForFn },
    });
    expect(invocations).toBe(1);

    // Within TTL — memo hit, primitive not invoked.
    now += 10_000;
    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-B' },
      memo: { cache: cache2, ttlForFn },
    });
    expect(invocations).toBe(1);

    // Past TTL — memo miss, primitive re-runs.
    now += 30_000;
    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-C' },
      memo: { cache: cache2, ttlForFn },
    });
    expect(invocations).toBe(2);
  });
});

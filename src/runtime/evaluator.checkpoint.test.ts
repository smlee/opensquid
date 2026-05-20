/**
 * DURABLE.2 — evaluator checkpoint-wrap tests.
 *
 * Covers the selective-checkpointing acceptance criteria:
 *
 *   1. Mixed-durability process [match_regex (false), llm_classify (true),
 *      state_lookup (false), emit_verdict (false)] → ONLY the durable step
 *      gets a checkpoint row written.
 *   2. Crash + resume: re-run a process whose run_id already has a completed
 *      checkpoint for the durable step → durable step is SKIPPED (primitive
 *      not invoked), output restored from store; non-durable steps re-execute
 *      every time.
 *   3. Mixed bag with multiple durables: only durable steps produce writes;
 *      a 1000-step process with 5 durable primitives produces exactly 5
 *      checkpoint writes.
 *   4. `as:` binding restored from checkpoint on resume — downstream non-
 *      durable steps see the restored value.
 *   5. Errored durable step → checkpoint written with `status: 'errored'`;
 *      resume re-runs the step (does not silently skip).
 *
 * Each test uses an in-memory libsql (`:memory:`) so the suite stays fast.
 * Primitive registrations use spy `execute` functions so we can assert
 * invocation counts (the load-bearing signal for selective checkpointing).
 */

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type EvalCtx, type FunctionDef, FunctionRegistry } from '../functions/registry.js';

import { CheckpointStore } from './durable/checkpoint_store.js';
import { evaluateProcess } from './evaluator.js';
import { err, ok } from './result.js';
import type { Event, ProcessStep } from './types.js';

import type { Client } from '@libsql/client';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

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

// Suppress the registry's "missing durable flag" warning for the test-only
// primitives below — every primitive in this file declares `durable`
// explicitly, but a few helper registrations (none in this file) might not.
// Tests register clean defs, so silencing is conservative.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// In-memory libsql per test; shared store handle for both first-pass and
// resume passes within a single test.
// ---------------------------------------------------------------------------

let client: Client;
let store: CheckpointStore;
beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  store = new CheckpointStore(client);
  await store.init();
});
afterEach(() => {
  client.close();
});

// ---------------------------------------------------------------------------
// Reusable primitive factories — capture spy + return defs with explicit
// durability declarations.
// ---------------------------------------------------------------------------

function cheapPrim(name: string, value: unknown): FunctionDef {
  const spy = vi.fn(() => Promise.resolve(ok(value)));
  const def: FunctionDef = {
    name,
    argSchema: z.object({}).passthrough(),
    execute: spy,
    durable: false,
    memoizable: false,
    costEstimateMs: 0.1,
  };
  // Attach spy for assertions.
  (def as unknown as { spy: typeof spy }).spy = spy;
  return def;
}

function durablePrim(name: string, value: unknown): FunctionDef {
  const spy = vi.fn(() => Promise.resolve(ok(value)));
  const def: FunctionDef = {
    name,
    argSchema: z.object({}).passthrough(),
    execute: spy,
    durable: true,
    memoizable: true,
    costEstimateMs: 3000,
  };
  (def as unknown as { spy: typeof spy }).spy = spy;
  return def;
}

function spyOf(def: FunctionDef): ReturnType<typeof vi.fn> {
  return (def as unknown as { spy: ReturnType<typeof vi.fn> }).spy;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluator + CheckpointStore — selective writes', () => {
  it('mixed-durability process writes ONLY one row for the one durable step', async () => {
    const matchRegex = cheapPrim('match_regex', { hit: true });
    const llmClassify = durablePrim('llm_classify', 'FOO');
    const stateLookup = cheapPrim('state_lookup', { count: 3 });
    const emitVerdict: FunctionDef = {
      name: 'verdict',
      argSchema: z.object({ level: z.string(), message: z.string() }),
      execute: (args) =>
        Promise.resolve(
          ok({
            level: (args as { level: string }).level,
            message: (args as { message: string }).message,
          }),
        ),
      durable: false,
      memoizable: false,
      costEstimateMs: 0.1,
    };

    const reg = new FunctionRegistry();
    reg.register(matchRegex);
    reg.register(llmClassify);
    reg.register(stateLookup);
    reg.register(emitVerdict);

    const steps: ProcessStep[] = [
      { call: 'match_regex' },
      { call: 'llm_classify', as: 'label' },
      { call: 'state_lookup' },
      { call: 'verdict', args: { level: 'pass', message: 'ok' } },
    ];

    const result = await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-selective' },
    });

    expect(result).toEqual({
      kind: 'verdict',
      verdict: { level: 'pass', message: 'ok' },
    });

    // Only the durable step produced a row.
    const rows = await store.fetchRun('run-selective');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fn).toBe('llm_classify');
    expect(rows[0]?.stepIdx).toBe(1);
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.asBinding).toBe('label');
  });

  it('1000-step process with 5 durable primitives produces exactly 5 writes', async () => {
    const cheap = cheapPrim('cheap', null);
    const dur = durablePrim('dur', 'x');

    const reg = new FunctionRegistry();
    reg.register(cheap);
    reg.register(dur);

    // Build a 1000-step process where every 200th step (indices 0, 200,
    // 400, 600, 800) is durable. That's exactly 5 durable steps.
    const steps: ProcessStep[] = [];
    for (let i = 0; i < 1000; i++) {
      steps.push({ call: i % 200 === 0 ? 'dur' : 'cheap' });
    }

    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-1000' },
    });

    const rows = await store.fetchRun('run-1000');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.stepIdx)).toEqual([0, 200, 400, 600, 800]);
    // Every row is the durable primitive.
    expect(rows.every((r) => r.fn === 'dur')).toBe(true);
  });
});

describe('evaluator + CheckpointStore — resume behavior', () => {
  it('resume re-runs cheap steps fresh + restores durable step from checkpoint', async () => {
    const matchRegex = cheapPrim('match_regex', { hit: true });
    const llmClassify = durablePrim('llm_classify', 'FOO');
    const stateLookup = cheapPrim('state_lookup', { count: 3 });
    const emitVerdict: FunctionDef = {
      name: 'verdict',
      argSchema: z.object({ level: z.string(), message: z.string() }),
      execute: vi.fn((args) =>
        Promise.resolve(
          ok({
            level: (args as { level: string }).level,
            message: (args as { message: string }).message,
          }),
        ),
      ),
      durable: false,
      memoizable: false,
      costEstimateMs: 0.1,
    };

    const reg = new FunctionRegistry();
    reg.register(matchRegex);
    reg.register(llmClassify);
    reg.register(stateLookup);
    reg.register(emitVerdict);

    const steps: ProcessStep[] = [
      { call: 'match_regex' },
      { call: 'llm_classify', as: 'label' },
      { call: 'state_lookup' },
      { call: 'verdict', args: { level: 'pass', message: 'ok' } },
    ];

    // First run — all four primitives execute.
    await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-resume' },
    });
    expect(spyOf(matchRegex)).toHaveBeenCalledTimes(1);
    expect(spyOf(llmClassify)).toHaveBeenCalledTimes(1);
    expect(spyOf(stateLookup)).toHaveBeenCalledTimes(1);

    // Reset call counts to isolate the resume pass.
    spyOf(matchRegex).mockClear();
    spyOf(llmClassify).mockClear();
    spyOf(stateLookup).mockClear();

    // Resume — same runId. The durable primitive must NOT be invoked; its
    // output should be restored from the prior checkpoint row.
    const ctx2 = createTestCtx();
    const result2 = await evaluateProcess(steps, ctx2, reg, {
      checkpoint: { store, runId: 'run-resume' },
    });

    expect(result2).toEqual({
      kind: 'verdict',
      verdict: { level: 'pass', message: 'ok' },
    });

    // Cheap primitives re-ran; durable was skipped (restored from checkpoint).
    expect(spyOf(matchRegex)).toHaveBeenCalledTimes(1);
    expect(spyOf(stateLookup)).toHaveBeenCalledTimes(1);
    expect(spyOf(llmClassify)).not.toHaveBeenCalled();
    // The restored `as:` binding must be visible to downstream steps.
    expect(ctx2.bindings.get('label')).toBe('FOO');
  });

  it('errored durable step writes status=errored; resume re-runs it', async () => {
    let invocations = 0;
    const flaky: FunctionDef = {
      name: 'flaky',
      argSchema: z.object({}).passthrough(),
      execute: () => {
        invocations += 1;
        if (invocations === 1) {
          return Promise.resolve(err({ kind: 'runtime' as const, message: 'transient' }));
        }
        return Promise.resolve(ok('eventually-ok'));
      },
      durable: true,
      memoizable: false,
      costEstimateMs: 100,
    };

    const reg = new FunctionRegistry();
    reg.register(flaky);

    const steps: ProcessStep[] = [{ call: 'flaky', as: 'val' }];

    // First pass — errors. Checkpoint row written with status='errored'.
    const r1 = await evaluateProcess(steps, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-flaky' },
    });
    expect(r1.kind).toBe('error');

    const rowsAfterError = await store.fetchRun('run-flaky');
    expect(rowsAfterError).toHaveLength(1);
    expect(rowsAfterError[0]?.status).toBe('errored');
    expect(rowsAfterError[0]?.errorMessage).toContain('transient');

    // Resume — the errored row must NOT short-circuit; the primitive must
    // run again and succeed this time.
    const ctx2 = createTestCtx();
    const r2 = await evaluateProcess(steps, ctx2, reg, {
      checkpoint: { store, runId: 'run-flaky' },
    });
    expect(r2).toEqual({ kind: 'no_verdict' });
    expect(invocations).toBe(2);
    expect(ctx2.bindings.get('val')).toBe('eventually-ok');

    // Errored row replaced by completed row (INSERT OR REPLACE).
    const rowsAfterRetry = await store.fetchRun('run-flaky');
    expect(rowsAfterRetry).toHaveLength(1);
    expect(rowsAfterRetry[0]?.status).toBe('completed');
    expect(rowsAfterRetry[0]?.outputs).toBe('eventually-ok');
  });

  it('different inputs (hash mismatch) re-execute the primitive', async () => {
    let invocations = 0;
    const echo: FunctionDef<{ value: string }, string> = {
      name: 'echo',
      argSchema: z.object({ value: z.string() }),
      execute: ({ value }) => {
        invocations += 1;
        return Promise.resolve(ok(value));
      },
      durable: true,
      memoizable: true,
      costEstimateMs: 100,
    };

    const reg = new FunctionRegistry();
    reg.register(echo);

    // First run with `value: A`
    const steps1: ProcessStep[] = [{ call: 'echo', args: { value: 'A' }, as: 'out' }];
    await evaluateProcess(steps1, createTestCtx(), reg, {
      checkpoint: { store, runId: 'run-hash' },
    });
    expect(invocations).toBe(1);

    // Second run, same runId + same stepIdx, BUT different args. Inputs
    // hash mismatch → primitive must re-execute, not return the stale
    // checkpoint value.
    const steps2: ProcessStep[] = [{ call: 'echo', args: { value: 'B' }, as: 'out' }];
    const ctx2 = createTestCtx();
    await evaluateProcess(steps2, ctx2, reg, {
      checkpoint: { store, runId: 'run-hash' },
    });
    expect(invocations).toBe(2);
    expect(ctx2.bindings.get('out')).toBe('B');
  });
});

describe('evaluator + CheckpointStore — no-checkpoint backward compat', () => {
  it('omitting the checkpoint option preserves the original behavior (no writes)', async () => {
    const dur = durablePrim('dur', 'x');

    const reg = new FunctionRegistry();
    reg.register(dur);

    const steps: ProcessStep[] = [{ call: 'dur' }];

    const result = await evaluateProcess(steps, createTestCtx(), reg);
    expect(result).toEqual({ kind: 'no_verdict' });
    expect(spyOf(dur)).toHaveBeenCalledTimes(1);

    // No store was passed — verify a fresh fetch returns empty for any runId.
    const rows = await store.fetchRun('any-run-id');
    expect(rows).toEqual([]);
  });
});

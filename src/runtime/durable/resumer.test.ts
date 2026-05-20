/**
 * Tests for `Resumer` (DURABLE.4). Mirrors spec acceptance + risk callouts:
 *  1. Happy path — 5 runs at various step indices → all resumed.
 *  2. Stale-window — older than window → filtered at SQL level.
 *  3. Terminal marker — finished run excluded from scan.
 *  4. Errored step retry — enters from lastCompletedStep + 1.
 *  5. Pack-version mismatch → skip + audit.
 *  6. Pack uninstalled (resolver null) → skip + audit.
 *  7. Manifest-orphan checkpoint → audit + skip.
 *  8. Env-var window override (OPENSQUID_RESUME_WINDOW_MS).
 *  9. Explicit resume bypasses window.
 * 10. Evaluator throws → audit `evaluator_error` + loop continues.
 */

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckpointStore } from './checkpoint_store.js';
import { Resumer, type AuditEntry, type ResolvedRule, type RuleResolver } from './resumer.js';

import type { Client } from '@libsql/client';

// ---------------------------------------------------------------------------
// Test scaffolding
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

type SeedStep =
  | [number, number]
  | [number, number, 'completed' | 'errored']
  | [number, number, 'completed' | 'errored', string];

interface SeedOpts {
  runId: string;
  packId?: string;
  packVersion?: string;
  skill?: string;
  ruleId?: string;
  eventKind?: string;
  eventPayload?: unknown;
  startedAtMs?: number;
  /** [(stepIdx, completedAtMs, status?, asBinding?)] */
  steps: SeedStep[];
}

async function seedRun(opts: SeedOpts): Promise<void> {
  await store.recordRunStart({
    runId: opts.runId,
    packId: opts.packId ?? 'p1',
    packVersion: opts.packVersion ?? '0.0.1',
    skill: opts.skill ?? 's1',
    ruleId: opts.ruleId ?? 'r1',
    eventKind: opts.eventKind ?? 'schedule',
    eventPayload: opts.eventPayload ?? { test: 1 },
    startedAtMs: opts.startedAtMs ?? 1_000,
  });
  for (const step of opts.steps) {
    const [stepIdx, completedAtMs] = step;
    const status = step[2] ?? 'completed';
    const asBinding = step[3];
    await store.append({
      runId: opts.runId,
      stepIdx,
      fn: 'op',
      inputsHash: `h${String(stepIdx)}`,
      outputs: { idx: stepIdx },
      startedAtMs: completedAtMs - 1,
      completedAtMs,
      status,
      ...(asBinding !== undefined ? { asBinding } : {}),
    });
  }
}

function happyResolver(packVersion = '0.0.1'): RuleResolver {
  return () =>
    Promise.resolve<ResolvedRule>({
      process: [{ call: 'op' }, { call: 'op' }, { call: 'op' }, { call: 'op' }, { call: 'op' }],
      packVersion,
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Resumer — happy path (5 interrupted runs)', () => {
  it('resumes all 5 runs from the correct entry stepIdx', async () => {
    const now = 100_000;
    const recent = now - 5_000; // well inside the 60s window
    for (let i = 0; i < 5; i++) {
      const steps: SeedOpts['steps'] = [];
      for (let j = 0; j <= i; j++) steps.push([j, recent + j]);
      await seedRun({ runId: `run-${String(i)}`, steps });
    }
    const evalCalls: { runId: string; entryStepIdx: number }[] = [];
    const audit: AuditEntry[] = [];
    const resumer = new Resumer({
      store,
      evaluator: ({ manifest, entryStepIdx }) => {
        evalCalls.push({ runId: manifest.runId, entryStepIdx });
        return Promise.resolve();
      },
      resolver: happyResolver(),
      auditLog: (e) => audit.push(e),
      nowMs: () => now,
    });
    const result = await resumer.resumeOnStartup();
    expect(result).toEqual({ resumed: 5, skipped: 0 });
    const byRun = Object.fromEntries(evalCalls.map((c) => [c.runId, c.entryStepIdx]));
    expect(byRun).toEqual({ 'run-0': 1, 'run-1': 2, 'run-2': 3, 'run-3': 4, 'run-4': 5 });
    expect(audit.filter((e) => e.event === 'resume_summary')).toHaveLength(1);
    expect(audit.filter((e) => e.event === 'resume_run')).toHaveLength(5);
  });
});

describe('Resumer — stale-window skip', () => {
  it('does not resume runs whose last step is older than the window', async () => {
    const now = 1_000_000;
    await seedRun({ runId: 'stale', steps: [[0, now - 120_000]] });
    const evaluator = vi.fn(() => Promise.resolve());
    const audit: AuditEntry[] = [];
    const resumer = new Resumer({
      store,
      evaluator,
      resolver: happyResolver(),
      auditLog: (e) => audit.push(e),
      nowMs: () => now,
    });
    const result = await resumer.resumeOnStartup();
    expect(result).toEqual({ resumed: 0, skipped: 0 });
    expect(evaluator).not.toHaveBeenCalled();
    expect(audit.find((e) => e.event === 'resume_summary')).toMatchObject({
      scanned: 0,
      resumed: 0,
      skippedOther: 0,
    });
  });
});

describe('Resumer — terminal marker excludes finished runs', () => {
  it('a run with a terminal marker is not scanned even within the window', async () => {
    const now = 100_000;
    await seedRun({ runId: 'done', steps: [[0, now - 5_000]] });
    await store.recordRunTerminal('done', 'no_verdict', now - 4_990);
    const evaluator = vi.fn(() => Promise.resolve());
    const resumer = new Resumer({
      store,
      evaluator,
      resolver: happyResolver(),
      nowMs: () => now,
    });
    expect((await resumer.resumeOnStartup()).resumed).toBe(0);
    expect(evaluator).not.toHaveBeenCalled();
  });
});

describe('Resumer — errored step retry', () => {
  it('enters from lastCompletedStep + 1; errored step at idx 3 → entry = 3', async () => {
    const now = 100_000;
    const recent = now - 5_000;
    await seedRun({
      runId: 'errored',
      steps: [
        [0, recent, 'completed'],
        [1, recent + 1, 'completed'],
        [2, recent + 2, 'completed'],
        [3, recent + 3, 'errored'],
      ],
    });
    let captured: number | null = null;
    const resumer = new Resumer({
      store,
      evaluator: ({ entryStepIdx }) => {
        captured = entryStepIdx;
        return Promise.resolve();
      },
      resolver: happyResolver(),
      nowMs: () => now,
    });
    await resumer.resumeOnStartup();
    expect(captured).toBe(3); // lastCompletedStep = 2 (errored row excluded)
  });
});

describe('Resumer — pack-version mismatch', () => {
  it('skips + audits when manifest version differs from resolver version', async () => {
    const now = 100_000;
    await seedRun({ runId: 'drift', packVersion: '0.0.1', steps: [[0, now - 5_000]] });
    const evaluator = vi.fn(() => Promise.resolve());
    const audit: AuditEntry[] = [];
    const resumer = new Resumer({
      store,
      evaluator,
      resolver: happyResolver('0.0.2'),
      auditLog: (e) => audit.push(e),
      nowMs: () => now,
    });
    expect(await resumer.resumeOnStartup()).toEqual({ resumed: 0, skipped: 1 });
    expect(evaluator).not.toHaveBeenCalled();
    expect(
      audit.find((e) => e.event === 'resume_skipped' && e.reason === 'pack_version_mismatch'),
    ).toBeDefined();
  });
});

describe('Resumer — pack uninstalled', () => {
  it('resolver returning null → pack_missing audit + skip', async () => {
    const now = 100_000;
    await seedRun({ runId: 'gone', steps: [[0, now - 5_000]] });
    const evaluator = vi.fn(() => Promise.resolve());
    const audit: AuditEntry[] = [];
    const resumer = new Resumer({
      store,
      evaluator,
      resolver: () => Promise.resolve(null),
      auditLog: (e) => audit.push(e),
      nowMs: () => now,
    });
    expect(await resumer.resumeOnStartup()).toEqual({ resumed: 0, skipped: 1 });
    expect(evaluator).not.toHaveBeenCalled();
    expect(
      audit.find((e) => e.event === 'resume_skipped' && e.reason === 'pack_missing'),
    ).toBeDefined();
  });
});

describe('Resumer — orphan checkpoint with no manifest', () => {
  it('manifest_missing audit + scan skips quietly', async () => {
    const now = 100_000;
    await store.append({
      runId: 'orphan',
      stepIdx: 0,
      fn: 'op',
      inputsHash: 'h0',
      outputs: { ok: true },
      startedAtMs: now - 5_001,
      completedAtMs: now - 5_000,
      status: 'completed',
    });
    const audit: AuditEntry[] = [];
    const evaluator = vi.fn(() => Promise.resolve());
    const resumer = new Resumer({
      store,
      evaluator,
      resolver: happyResolver(),
      auditLog: (e) => audit.push(e),
      nowMs: () => now,
    });
    expect((await resumer.resumeOnStartup()).resumed).toBe(0);
    expect(evaluator).not.toHaveBeenCalled();
    expect(
      audit.find((e) => e.event === 'resume_skipped' && e.reason === 'manifest_missing'),
    ).toBeDefined();
  });
});

describe('Resumer — env-var window override', () => {
  let priorEnv: string | undefined;
  beforeEach(() => {
    priorEnv = process.env.OPENSQUID_RESUME_WINDOW_MS;
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env.OPENSQUID_RESUME_WINDOW_MS;
    else process.env.OPENSQUID_RESUME_WINDOW_MS = priorEnv;
  });

  it('honors OPENSQUID_RESUME_WINDOW_MS for a longer window', async () => {
    const now = 1_000_000;
    await seedRun({ runId: 'long-window', steps: [[0, now - 300_000]] }); // 5min ago
    process.env.OPENSQUID_RESUME_WINDOW_MS = String(600_000);
    const evaluator = vi.fn(() => Promise.resolve());
    const resumer = new Resumer({
      store,
      evaluator,
      resolver: happyResolver(),
      nowMs: () => now,
    });
    expect((await resumer.resumeOnStartup()).resumed).toBe(1);
    expect(evaluator).toHaveBeenCalledOnce();
  });
});

describe('Resumer — explicit resume bypasses window', () => {
  it('resume() runs even when the run is well past the window', async () => {
    const now = 1_000_000;
    const old = now - 24 * 60 * 60_000; // 24h ago
    await seedRun({ runId: 'old-but-explicit', steps: [[0, old]] });
    const evaluator = vi.fn(() => Promise.resolve());
    const resumer = new Resumer({
      store,
      evaluator,
      resolver: happyResolver(),
      nowMs: () => now,
    });
    const m = await store.getRunManifest('old-but-explicit');
    if (!m) throw new Error('seed missing');
    const result = await resumer.resume({
      runId: m.runId,
      packId: m.packId,
      packVersion: m.packVersion,
      skill: m.skill,
      ruleId: m.ruleId,
      eventKind: m.eventKind,
      eventPayload: m.eventPayload,
      lastCompletedStep: 0,
      lastCompletedAtMs: old,
    });
    expect(result.resumed).toBe(true);
    expect(evaluator).toHaveBeenCalledOnce();
  });
});

describe('Resumer — evaluator error path', () => {
  it('logs evaluator_error + does not crash the resume loop', async () => {
    const now = 100_000;
    const recent = now - 5_000;
    await seedRun({ runId: 'bad-1', steps: [[0, recent]] });
    await seedRun({ runId: 'bad-2', steps: [[0, recent + 1]] });
    let calls = 0;
    const audit: AuditEntry[] = [];
    const resumer = new Resumer({
      store,
      evaluator: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
      },
      resolver: happyResolver(),
      auditLog: (e) => audit.push(e),
      nowMs: () => now,
    });
    const result = await resumer.resumeOnStartup();
    expect(calls).toBe(2);
    expect(result).toEqual({ resumed: 1, skipped: 1 });
    expect(
      audit.find((e) => e.event === 'resume_skipped' && e.reason === 'evaluator_error'),
    ).toBeDefined();
  });
});

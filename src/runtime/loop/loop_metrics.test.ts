/**
 * LSF.5 (subprocess-harness-push.md §3a) — the project-local `loop_metrics` history.
 *
 * Covers: the per-stage write; the SQL-filterable read (since/task/harness) ordered most-recent-first; the
 * per-loop SUM aggregate (per-loop = the aggregate of its stages); notional cost recorded on subscription too.
 *
 * Uses a real libsql behind `withLoopDb` via an `OPENSQUID_PROJECT_ROOT` tmpdir override (the project-LOCAL
 * seam `loopDbUrl()` honors — PLS.3), so the test exercises the actual SQL against a local store, not a mock.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordStageMetric,
  readMetrics,
  aggregatePerLoop,
  type LoopMetricRow,
} from './loop_metrics.js';

const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'loop-metrics-'));
  mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

function row(over: Partial<LoopMetricRow> = {}): LoopMetricRow {
  return {
    runId: 'run-1',
    itemId: 'wg-a',
    stage: 'code',
    harness: 'claude',
    authMode: 'subscription',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
    durationMs: 1_000,
    costUsd: 0.5,
    inputTokens: 100,
    outputTokens: 40,
    ...over,
  };
}

describe('loop_metrics', () => {
  it('records a per-stage row and reads it back', async () => {
    await recordStageMetric(row());
    const rows = await readMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: 'wg-a',
      stage: 'code',
      costUsd: 0.5,
      inputTokens: 100,
    });
  });

  it('records the NOTIONAL cost even on subscription (never gated on api)', async () => {
    await recordStageMetric(row({ authMode: 'subscription', costUsd: 1.23 }));
    const [r] = await readMetrics();
    expect(r?.authMode).toBe('subscription');
    expect(r?.costUsd).toBe(1.23);
  });

  it('orders most-recent first and filters by since / task / harness', async () => {
    await recordStageMetric(row({ stage: 'scope_write', startedAtMs: 1_000 }));
    await recordStageMetric(row({ stage: 'code', startedAtMs: 5_000 }));
    await recordStageMetric(
      row({ itemId: 'wg-b', stage: 'plan', startedAtMs: 3_000, harness: 'codex' }),
    );

    const all = await readMetrics();
    expect(all.map((r) => r.stage)).toEqual(['code', 'plan', 'scope_write']); // started_at_ms DESC

    expect((await readMetrics({ sinceMs: 4_000 })).map((r) => r.stage)).toEqual(['code']);
    expect((await readMetrics({ itemId: 'wg-b' })).map((r) => r.stage)).toEqual(['plan']);
    expect((await readMetrics({ harness: 'codex' })).map((r) => r.harness)).toEqual(['codex']);
  });

  it('aggregatePerLoop SUMs a run’s stage rows (per-loop = the aggregate of its stages)', async () => {
    await recordStageMetric(
      row({
        stage: 'author',
        startedAtMs: 1_000,
        endedAtMs: 2_000,
        durationMs: 1_000,
        costUsd: 0.2,
        inputTokens: 10,
        outputTokens: 5,
      }),
    );
    await recordStageMetric(
      row({
        stage: 'code',
        startedAtMs: 2_000,
        endedAtMs: 6_000,
        durationMs: 4_000,
        costUsd: 0.8,
        inputTokens: 90,
        outputTokens: 35,
      }),
    );

    const loops = await aggregatePerLoop();
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({
      runId: 'run-1',
      stages: 2,
      durationMs: 5_000,
      inputTokens: 100,
      outputTokens: 40,
      startedAtMs: 1_000, // MIN
      endedAtMs: 6_000, // MAX
    });
    expect(loops[0]?.costUsd).toBeCloseTo(1.0, 5);
  });

  it('groups the aggregate per run_id', async () => {
    await recordStageMetric(row({ runId: 'run-1', costUsd: 0.5 }));
    await recordStageMetric(row({ runId: 'run-2', costUsd: 0.7 }));
    const loops = await aggregatePerLoop();
    expect(loops.map((l) => l.runId).sort()).toEqual(['run-1', 'run-2']);
  });
});

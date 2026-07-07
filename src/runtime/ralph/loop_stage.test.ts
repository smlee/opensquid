/**
 * GS1 — the ralph loop's scope gate over the durable task_checkpoints store (drive / hold + reset semantics).
 * Uses an injected in-memory CheckpointStore so the decision is exercised without touching opensquid.db.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckpointStore } from '../durable/checkpoint_store.js';
import { recordStageMetric, readMetrics } from '../loop/loop_metrics.js';
import {
  scopeGate,
  readLoopStage,
  clearLoopStage,
  withTaskCheckpointStore,
  upsertTaskStage,
} from './loop_stage.js';
import { ensureLoopRunning } from './loop_autospawn.js';

import type { Client } from '@libsql/client';

// ATL.3/ATL.4 — mock the loop-autospawn trigger so the scope-3 wire-test never spawns a real loop; the spy
// lets us assert fire-once on scope_write / no-fire otherwise / fail-open. The other describes never call it.
vi.mock('./loop_autospawn.js', () => ({
  ensureLoopRunning: vi.fn().mockResolvedValue({ status: 'spawned', pid: 1 }),
}));
const ensureLoopRunningMock = vi.mocked(ensureLoopRunning);

const yes = (): Promise<boolean> => Promise.resolve(true);
const no = (): Promise<boolean> => Promise.resolve(false);

describe('loop_stage — scopeGate (GS1 scope proof, checkpoint-backed)', () => {
  let client: Client;
  let store: CheckpointStore;
  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    store = new CheckpointStore(client);
    await store.init();
  });
  afterEach(() => client.close());

  it('no checkpoint (fresh) → hold (automation never scopes); the no-op reset leaves the checkpoint absent', async () => {
    expect(await scopeGate('wg-fresh', no, store)).toBe('hold');
    // updateTaskStage is UPDATE-only — it must NOT fabricate a checkpoint for a fresh item.
    expect(await store.getTaskCheckpoint('wg-fresh')).toBeNull();
  });

  it('the human-only `scope` stage → hold (out of automation; awaits interactive scope)', async () => {
    await store.createTaskCheckpoint('wg-s', 'scope', 1);
    expect(await scopeGate('wg-s', yes, store)).toBe('hold'); // even with `exists`→true: stage `scope` is never driven
  });

  it('an automated stage (scope_write) with NO artifact → hold + fix to scope (not really scoped)', async () => {
    await store.createTaskCheckpoint('wg-sw', 'scope_write', 1);
    expect(await scopeGate('wg-sw', yes, store)).toBe('hold');
    expect((await store.getTaskCheckpoint('wg-sw'))?.stage).toBe('scope');
  });

  it('an automated stage (scope_write) WITH an on-disk artifact → drive (really scoped)', async () => {
    await store.createTaskCheckpoint('wg-swp', 'scope_write', 1);
    await store.setTaskArtifacts('wg-swp', ['docs/research/a-pre-research.md'], 1);
    expect(await scopeGate('wg-swp', yes, store)).toBe('drive');
  });

  it('past scope WITH an artifact that EXISTS on disk → drive', async () => {
    await store.createTaskCheckpoint('wg-p', 'author', 1);
    await store.setTaskArtifacts('wg-p', ['docs/research/a-pre-research.md'], 1);
    expect(await scopeGate('wg-p', yes, store)).toBe('drive');
  });

  it('past scope but the recorded artifact is MISSING on disk → hold + fix to scope', async () => {
    await store.createTaskCheckpoint('wg-m', 'author', 1);
    await store.setTaskArtifacts('wg-m', ['docs/research/gone-pre-research.md'], 1);
    expect(await scopeGate('wg-m', no, store)).toBe('hold');
    expect(await store.getTaskCheckpoint('wg-m')).toEqual({
      stage: 'scope', // fixed to scope — not really scoped
      scopeArtifacts: ['docs/research/gone-pre-research.md'],
    });
  });

  it('past scope with NO recorded artifact → hold + fix to scope (exists never consulted)', async () => {
    await store.createTaskCheckpoint('wg-n', 'plan', 1);
    expect(await scopeGate('wg-n', yes, store)).toBe('hold');
    expect((await store.getTaskCheckpoint('wg-n'))?.stage).toBe('scope');
  });

  it('a fixed-to-scope item STAYS held on the next pass (automation never re-scopes — no auto-redrive)', async () => {
    await store.createTaskCheckpoint('wg-x', 'plan', 1);
    expect(await scopeGate('wg-x', no, store)).toBe('hold'); // fixed to scope
    expect(await scopeGate('wg-x', no, store)).toBe('hold'); // stage is now `scope` → still held (NOT driven)
    expect((await store.getTaskCheckpoint('wg-x'))?.stage).toBe('scope');
  });

  it('re-admission: after interactive scope (checkpoint past `scope` + on-disk artifact) the gate drives', async () => {
    // Model the FSM write-through re-admitting a previously-held item: it advances past `scope` and records the
    // on-disk pre-research artifact. The gate then treats it as really scoped → drive.
    await store.createTaskCheckpoint('wg-re', 'scope', 1);
    expect(await scopeGate('wg-re', no, store)).toBe('hold'); // unscoped → held
    await store.updateTaskStage('wg-re', 'scope_write', 2); // human scopes interactively: advance past `scope`
    await store.setTaskArtifacts('wg-re', ['docs/research/re-pre-research.md'], 2); // + record the artifact
    expect(await scopeGate('wg-re', yes, store)).toBe('drive'); // re-admitted
  });
});

describe('loop_stage — project-LOCAL opensquid.db opener (PLS.3 table split; WAL posture)', () => {
  // The IN opener resolves `<root>/.opensquid/opensquid.db` via the OPENSQUID_PROJECT_ROOT test seam. The GLOBAL
  // home is pointed at a SEPARATE tmpdir so the tests can prove the checkpoint/loop tables land LOCAL, never global.
  let projectRoot: string;
  let globalHome: string;
  let priorRoot: string | undefined;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorRoot = process.env.OPENSQUID_PROJECT_ROOT;
    priorHome = process.env.OPENSQUID_HOME;
    projectRoot = mkdtempSync(join(tmpdir(), 'osq-proj-'));
    mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
    globalHome = mkdtempSync(join(tmpdir(), 'osq-home-'));
    process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
    process.env.OPENSQUID_HOME = globalHome;
  });
  afterEach(() => {
    if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('readLoopStage round-trips the recorded stage through the LOCAL opener (fresh → null)', async () => {
    expect(await readLoopStage('wg-r')).toBeNull(); // fresh
    await withTaskCheckpointStore((s) => s.createTaskCheckpoint('wg-r', 'code', 1));
    expect(await readLoopStage('wg-r')).toBe('code');
  });

  it('clearLoopStage is a no-op (resolves without throwing)', async () => {
    await expect(clearLoopStage('wg-anything')).resolves.toBeUndefined();
  });

  it('opens `<root>/.opensquid/opensquid.db` — NOT the global home (the split boundary)', async () => {
    await withTaskCheckpointStore((s) => s.createTaskCheckpoint('wg-loc', 'author', 1));
    expect(existsSync(join(projectRoot, '.opensquid', 'opensquid.db'))).toBe(true);
    expect(existsSync(join(globalHome, 'opensquid.db'))).toBe(false); // checkpoints are LOCAL, not global
  });

  it('a checkpoint + a loop metric round-trip through the SAME local opensquid.db', async () => {
    await withTaskCheckpointStore((s) => s.createTaskCheckpoint('wg-rt', 'code', 1_000));
    await recordStageMetric({
      runId: 'run-rt',
      itemId: 'wg-rt',
      stage: 'code',
      harness: 'claude',
      authMode: 'subscription',
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      durationMs: 1_000,
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 40,
    });
    // Both stores resolved the identical local file, so each sees the other's writer's rows.
    expect(await readLoopStage('wg-rt')).toBe('code');
    const metrics = await readMetrics({ itemId: 'wg-rt' });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.stage).toBe('code');
    // One db file, in the LOCAL store — nothing leaked to the global home.
    expect(existsSync(join(projectRoot, '.opensquid', 'opensquid.db'))).toBe(true);
    expect(existsSync(join(globalHome, 'opensquid.db'))).toBe(false);
  });
});

describe('loop_stage — scope-3 loop-autospawn trigger (ATL.3: fire on scope_write, fail-open)', () => {
  // upsertTaskStage writes the durable checkpoint through the LOCAL opener, then fires ensureLoopRunning ONLY on
  // scope_write. Same OPENSQUID_PROJECT_ROOT seam as above so the write lands in a temp store, never the repo db.
  let projectRoot: string;
  let priorRoot: string | undefined;
  let priorHome: string | undefined;
  beforeEach(() => {
    priorRoot = process.env.OPENSQUID_PROJECT_ROOT;
    priorHome = process.env.OPENSQUID_HOME;
    projectRoot = mkdtempSync(join(tmpdir(), 'osq-atl3-'));
    mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
    process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
    process.env.OPENSQUID_HOME = mkdtempSync(join(tmpdir(), 'osq-atl3-home-'));
    ensureLoopRunningMock.mockClear();
    ensureLoopRunningMock.mockResolvedValue({ status: 'spawned', pid: 1 });
  });
  afterEach(() => {
    if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('fires the loop trigger exactly once on a scope_write advance', async () => {
    await upsertTaskStage('wg-t', 'scope_write', 1);
    expect(ensureLoopRunningMock).toHaveBeenCalledTimes(1);
    // it targets the current project (process.cwd()) — the same project the checkpoint was written to.
    expect(ensureLoopRunningMock).toHaveBeenCalledWith(process.cwd());
    expect(await readLoopStage('wg-t')).toBe('scope_write'); // the durable write still landed
  });

  it('does NOT fire on a non-scope_write stage (the guard)', async () => {
    await upsertTaskStage('wg-t2', 'plan', 1);
    expect(ensureLoopRunningMock).not.toHaveBeenCalled();
    expect(await readLoopStage('wg-t2')).toBe('plan');
  });

  it('a trigger throw NEVER breaks the checkpoint write (fail-open — the ask invariant)', async () => {
    ensureLoopRunningMock.mockRejectedValueOnce(new Error('boom'));
    await expect(upsertTaskStage('wg-t3', 'scope_write', 1)).resolves.toBeUndefined();
    expect(await readLoopStage('wg-t3')).toBe('scope_write'); // the write survived the trigger fault
  });
});

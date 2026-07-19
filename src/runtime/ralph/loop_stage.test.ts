/**
 * GS1 — the ralph loop's scope gate over the durable task_checkpoints store (drive / hold + reset semantics).
 * Uses an injected in-memory CheckpointStore so the decision is exercised without touching opensquid.db.
 */
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../durable/checkpoint_store.js';
import { recordStageMetric, readMetrics } from '../loop/loop_metrics.js';
import {
  automationAdmission,
  readLoopStage,
  clearLoopStage,
  withTaskCheckpointStore,
  upsertTaskStage,
} from './loop_stage.js';
import { tailEventsSince, foldEvents } from '../loop/loop_events.js';

import type { Client } from '@libsql/client';

const yes = (): Promise<boolean> => Promise.resolve(true);
const no = (): Promise<boolean> => Promise.resolve(false);
const receipt = (_artifactPath: string): Promise<boolean> => Promise.resolve(true);

describe('loop_stage — opaque automation admission', () => {
  let client: Client;
  let store: CheckpointStore;
  const isAutomated = (stageId: string): boolean => stageId === 'beta' || stageId === 'gamma';

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    store = new CheckpointStore(client);
    await store.init();
  });
  afterEach(() => client.close());

  it('holds a fresh item without fabricating a checkpoint', async () => {
    expect(await automationAdmission('wg-fresh', isAutomated, no, store)).toBe('hold');
    expect(await store.getTaskCheckpoint('wg-fresh')).toBeNull();
  });

  it('holds an undeclared state without rewriting it', async () => {
    await store.createTaskCheckpoint('wg-a', 'alpha', 1);
    expect(await automationAdmission('wg-a', isAutomated, yes, store)).toBe('hold');
    expect((await store.getTaskCheckpoint('wg-a'))?.stage).toBe('alpha');
  });

  it('holds a declared state without artifact proof or receipt', async () => {
    await store.createTaskCheckpoint('wg-b', 'beta', 1);
    expect(await automationAdmission('wg-b', isAutomated, yes, store)).toBe('hold');
    await store.setTaskArtifacts('wg-b', ['/approved/artifact.md'], 2);
    expect(await automationAdmission('wg-b', isAutomated, yes, store)).toBe('hold');
  });

  it('drives a declared state with one existing artifact and semantic receipt', async () => {
    await store.createTaskCheckpoint('wg-c', 'gamma', 1);
    await store.setTaskArtifacts('wg-c', ['/approved/artifact.md'], 2);
    expect(await automationAdmission('wg-c', isAutomated, yes, store, receipt)).toBe('drive');
  });

  it('holds missing artifact bytes without changing the opaque state', async () => {
    await store.createTaskCheckpoint('wg-d', 'gamma', 1);
    await store.setTaskArtifacts('wg-d', ['/missing/artifact.md'], 2);
    expect(await automationAdmission('wg-d', isAutomated, no, store, receipt)).toBe('hold');
    expect((await store.getTaskCheckpoint('wg-d'))?.stage).toBe('gamma');
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

describe('loop_stage — generic writer ownership', () => {
  // The writer stamps opaque state ids; approval authority is enforced by admission and artifact receipts.
  // The OPENSQUID_PROJECT_ROOT seam keeps every checkpoint/event in a temp store.
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
  });
  afterEach(() => {
    if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('round-trips an arbitrary pack state without assigning it core meaning', async () => {
    await upsertTaskStage('wg-t', 'pack-state-17', 1);
    expect(await readLoopStage('wg-t')).toBe('pack-state-17');
  });

  it('LMP.2: pushes exactly one stage_advance monitor event AFTER the durable write', async () => {
    await upsertTaskStage('wg-adv', 'delta', 42);
    const events = await tailEventsSince(0);
    const advances = events.filter((e) => e.kind === 'stage_advance' && e.wgId === 'wg-adv');
    expect(advances).toHaveLength(1);
    expect(advances[0]).toMatchObject({ stage: 'delta', atMs: 42 });
    expect(await readLoopStage('wg-adv')).toBe('delta'); // the checkpoint advanced too
  });

  it('an opaque state advance folds to a stage-granular row with phase cleared', async () => {
    await upsertTaskStage('wg-ncr', 'epsilon', 7);
    const [folded] = foldEvents(await tailEventsSince(0)).filter((s) => s.wgId === 'wg-ncr');
    expect(folded).toMatchObject({ wgId: 'wg-ncr', stage: 'epsilon' });
    expect(folded?.phase).toBeUndefined(); // stage-granular: a fresh stage has no phase yet (loop_events.ts:201-211)
  });
});

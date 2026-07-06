/**
 * GS1 — the ralph loop's scope gate over the durable task_checkpoints store (drive / hold + reset semantics).
 * Uses an injected in-memory CheckpointStore so the decision is exercised without touching opensquid.db.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../durable/checkpoint_store.js';
import { scopeGate, readLoopStage, clearLoopStage, withTaskCheckpointStore } from './loop_stage.js';

import type { Client } from '@libsql/client';

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

describe('loop_stage — readLoopStage / clearLoopStage (own opensquid.db opener + WAL posture)', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env.OPENSQUID_HOME;
    home = mkdtempSync(join(tmpdir(), 'osq-loopstage-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    rmSync(home, { recursive: true, force: true });
  });

  it('readLoopStage round-trips the recorded stage through the module opener (fresh → null)', async () => {
    expect(await readLoopStage('wg-r')).toBeNull(); // fresh
    await withTaskCheckpointStore((s) => s.createTaskCheckpoint('wg-r', 'code', 1));
    expect(await readLoopStage('wg-r')).toBe('code');
  });

  it('clearLoopStage is a no-op (resolves without throwing)', async () => {
    await expect(clearLoopStage('wg-anything')).resolves.toBeUndefined();
  });
});

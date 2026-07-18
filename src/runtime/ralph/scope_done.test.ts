import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Issue } from '../../workgraph/types.js';
import { CheckpointStore } from '../durable/checkpoint_store.js';
import { ensureLoopEventSchema } from '../loop/loop_events.js';
import { completeInteractiveScope, type CompleteScopeDeps } from './scope_done.js';

interface Fixture {
  workspace: string;
  project: string;
  docs: string;
  artifact: string;
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  delete process.env.OPENSQUID_PROJECT_ROOT;
});

async function fixture(active: unknown = { packs: [], docsRoot: '../docs' }): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'opensquid-scope-done-'));
  cleanup.push(workspace);
  const project = join(workspace, 'opensquid');
  const docs = join(workspace, 'docs');
  const artifact = join(docs, 'research', 'scope.md');
  await mkdir(join(project, '.opensquid'), { recursive: true });
  await mkdir(join(docs, 'research'), { recursive: true });
  await writeFile(join(project, '.opensquid', 'active.json'), JSON.stringify(active));
  await writeFile(artifact, '# approved scope\n');
  return { workspace, project, docs, artifact };
}

const issue = (id = 'wg-1'): Issue => ({
  id,
  title: 'scope handoff',
  body: '',
  status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

function deps(overrides: CompleteScopeDeps = {}): CompleteScopeDeps {
  return {
    loadIssue: (_context, id) => Promise.resolve(issue(id)),
    loadPolicy: () =>
      Promise.resolve({
        initialStage: 'scope',
        entryStage: 'scope_write',
        repairStages: new Set([
          'scope_write',
          'plan',
          'author',
          'code',
          'deploy',
          'verify',
          'deploy_fix',
          'accept',
        ]),
      }),
    ensureLoop: vi.fn(() => Promise.resolve({ status: 'already_running' as const, pid: 42 })),
    refreshProjection: vi.fn(() => Promise.resolve()),
    nowMs: () => 1234,
    ...overrides,
  };
}

async function readPersisted(f: Fixture, id = 'wg-1') {
  const url = `file:${join(f.project, '.opensquid', 'opensquid.db')}`;
  const client = createClient({ url });
  try {
    const cp = await new CheckpointStore(client).getTaskCheckpoint(id);
    const events = await client.execute({
      sql: `SELECT action_id,stage,scope_artifact_path,scope_artifact_sha256,scope_evidence_kind
            FROM loop_events WHERE wg_id=? AND action_id LIKE 'scope-handoff:v1:%' ORDER BY seq`,
      args: [id],
    });
    return { cp, events: events.rows };
  } finally {
    client.close();
  }
}

describe('completeInteractiveScope', () => {
  it('advances the existing descriptor-created scope checkpoint through unchanged scope-done exactly once', async () => {
    const f = await fixture();
    const client = createClient({ url: `file:${join(f.project, '.opensquid', 'opensquid.db')}` });
    await new CheckpointStore(client).createTaskCheckpoint('wg-1', 'scope', 1000);
    client.close();
    const ensureLoop = vi.fn(() =>
      Promise.resolve({ status: 'already_running' as const, pid: 42 }),
    );

    const entered = await completeInteractiveScope(
      { wgId: 'wg-1', artifact: f.artifact, cwd: f.project },
      deps({ ensureLoop }),
    );
    expect(entered).toMatchObject({
      wgId: 'wg-1',
      transition: 'entered',
      checkpointStage: 'scope_write',
    });
    expect((await readPersisted(f)).cp).toMatchObject({ stage: 'scope_write' });
    expect(ensureLoop).toHaveBeenCalledTimes(1);
  });

  it('accepts the configured sibling docsRoot and atomically enters scope_write with one approval receipt', async () => {
    const f = await fixture();
    const d = deps();
    const result = await completeInteractiveScope(
      { wgId: 'wg-1', artifact: f.artifact, cwd: f.project },
      d,
    );

    const canonicalArtifact = await realpath(f.artifact);
    const artifactSha256 = createHash('sha256').update('# approved scope\n').digest('hex');
    const actionDigest = createHash('sha256')
      .update(JSON.stringify(['wg-1', canonicalArtifact]), 'utf8')
      .digest('hex');
    expect(result).toEqual({
      kind: 'scope_handoff',
      wgId: 'wg-1',
      artifact: canonicalArtifact,
      artifactSha256,
      evidenceKind: 'approval',
      actionId: `scope-handoff:v1:${actionDigest}`,
      transition: 'entered',
      checkpointStage: 'scope_write',
      loop: { status: 'already_running', pid: 42 },
    });
    expect(d.ensureLoop).toHaveBeenCalledWith(await realpath(f.project));

    const persisted = await readPersisted(f);
    expect(persisted.cp).toEqual({ stage: 'scope_write', scopeArtifacts: [canonicalArtifact] });
    expect(persisted.events).toHaveLength(1);
    expect(persisted.events[0]).toMatchObject({
      action_id: result.actionId,
      stage: 'scope_write',
      scope_artifact_path: canonicalArtifact,
      scope_artifact_sha256: artifactSha256,
      scope_evidence_kind: 'approval',
    });
  });

  it('bounds post-commit liveness reconciliation without duplicating the receipt', async () => {
    const f = await fixture();
    const ensureLoop = vi
      .fn()
      .mockResolvedValueOnce({ status: 'error' as const, error: 'first' })
      .mockResolvedValueOnce({ status: 'error' as const, error: 'second' })
      .mockResolvedValueOnce({ status: 'spawned' as const, pid: 51 });
    const sleep = vi.fn(() => Promise.resolve());

    const result = await completeInteractiveScope(
      { wgId: 'wg-1', artifact: f.artifact, cwd: f.project },
      deps({ ensureLoop, sleep }),
    );

    expect(result.loop).toEqual({ status: 'spawned', pid: 51 });
    expect(ensureLoop).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [1_000]]);
    expect((await readPersisted(f)).events).toHaveLength(1);
  });

  it('reuses the immutable receipt after content changes and reconciles liveness again', async () => {
    const f = await fixture();
    const ensureLoop = vi.fn(() => Promise.resolve({ status: 'spawned' as const, pid: 51 }));
    const d = deps({ ensureLoop });
    const entered = await completeInteractiveScope(
      { wgId: 'wg-1', artifact: f.artifact, cwd: f.project },
      d,
    );
    await writeFile(f.artifact, '# scope_write formalized content\n');
    const reused = await completeInteractiveScope(
      { wgId: 'wg-1', artifact: f.artifact, cwd: f.project },
      d,
    );

    expect(reused.transition).toBe('reused');
    expect(reused.artifactSha256).toBe(entered.artifactSha256);
    expect(ensureLoop).toHaveBeenCalledTimes(2);
    expect((await readPersisted(f)).events).toHaveLength(1);
  });

  it('serializes concurrent same-path approvals into one entered and one reused transition', async () => {
    const f = await fixture();
    const d = deps();
    const results = await Promise.all([
      completeInteractiveScope({ wgId: 'wg-1', artifact: f.artifact, cwd: f.project }, d),
      completeInteractiveScope({ wgId: 'wg-1', artifact: f.artifact, cwd: f.project }, d),
    ]);
    expect(results.map((result) => result.transition).sort()).toEqual(['entered', 'reused']);
    expect((await readPersisted(f)).events).toHaveLength(1);
  });

  it('repairs an eligible pre-fix checkpoint without regressing its current stage or rewriting legacy history', async () => {
    const f = await fixture();
    const canonicalArtifact = await realpath(f.artifact);
    const url = `file:${join(f.project, '.opensquid', 'opensquid.db')}`;
    const client = createClient({ url });
    try {
      const store = new CheckpointStore(client);
      await store.init();
      await store.createTaskCheckpoint('wg-1', 'code', 1);
      await store.setTaskArtifacts('wg-1', [canonicalArtifact], 1);
      await ensureLoopEventSchema(client, url);
      // Simulate unkeyed history created before semantic handoff receipts existed.
      await client.execute({
        sql: `INSERT INTO loop_events (wg_id,kind,stage,at_ms) VALUES (?,'stage_advance','scope_write',?)`,
        args: ['wg-1', 1],
      });
    } finally {
      client.close();
    }

    const result = await completeInteractiveScope(
      { wgId: 'wg-1', artifact: f.artifact, cwd: f.project },
      deps(),
    );
    expect(result).toMatchObject({
      transition: 'repaired',
      checkpointStage: 'code',
      evidenceKind: 'legacy_repair',
    });
    const persisted = await readPersisted(f);
    expect(persisted.cp?.stage).toBe('code');
    expect(persisted.events).toHaveLength(1);
    const verifyClient = createClient({ url });
    try {
      const legacy = await verifyClient.execute(
        `SELECT seq FROM loop_events WHERE wg_id='wg-1' AND action_id IS NULL`,
      );
      expect(legacy.rows).toHaveLength(1);
    } finally {
      verifyClient.close();
    }
  });

  it('protects approved checkpoint artifacts without interpreting state ids', async () => {
    const f = await fixture();
    await completeInteractiveScope({ wgId: 'wg-1', artifact: f.artifact, cwd: f.project }, deps());
    const client = createClient({ url: `file:${join(f.project, '.opensquid', 'opensquid.db')}` });
    try {
      await expect(
        client.execute({
          sql: `UPDATE task_checkpoints SET scope_artifacts_json=? WHERE task_id=?`,
          args: [JSON.stringify(['/different/scope.md']), 'wg-1'],
        }),
      ).rejects.toThrow('checkpoint artifact requires a scope-handoff receipt');
      await expect(
        client.execute({
          sql: `INSERT INTO task_checkpoints
                  (task_id,stage,scope_artifacts_json,created_at_ms,updated_at_ms)
                VALUES (?,'opaque-state','[]',1,1)`,
          args: ['wg-direct'],
        }),
      ).resolves.toBeDefined();
      await expect(
        client.execute({
          sql: `UPDATE task_checkpoints SET stage='another-state' WHERE task_id=?`,
          args: ['wg-direct'],
        }),
      ).resolves.toBeDefined();
      await expect(
        client.execute({
          sql: `INSERT INTO task_checkpoints
                  (task_id,stage,scope_artifacts_json,created_at_ms,updated_at_ms)
                VALUES (?,'any-state',?,1,1)`,
          args: ['wg-unapproved-artifact', JSON.stringify(['/unapproved/artifact.md'])],
        }),
      ).rejects.toThrow('checkpoint artifact requires a scope-handoff receipt');
    } finally {
      client.close();
    }
  });

  it('rejects a different approved path for an item that already has a receipt', async () => {
    const f = await fixture();
    await completeInteractiveScope({ wgId: 'wg-1', artifact: f.artifact, cwd: f.project }, deps());
    const other = join(f.docs, 'research', 'other.md');
    await writeFile(other, '# other\n');
    await expect(
      completeInteractiveScope({ wgId: 'wg-1', artifact: other, cwd: f.project }, deps()),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await readPersisted(f)).events).toHaveLength(1);
  });

  it('rejects an oversized scope artifact without buffering it', async () => {
    const f = await fixture();
    await truncate(f.artifact, 16 * 1024 * 1024 + 1);
    await expect(
      completeInteractiveScope({ wgId: 'wg-1', artifact: f.artifact, cwd: f.project }, deps()),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects project-local docs when the configured authority is the sibling docsRoot', async () => {
    const f = await fixture();
    const forbidden = join(f.project, 'docs', 'research', 'scope.md');
    await mkdir(join(f.project, 'docs', 'research'), { recursive: true });
    await writeFile(forbidden, '# wrong root\n');
    await expect(
      completeInteractiveScope({ wgId: 'wg-1', artifact: forbidden, cwd: f.project }, deps()),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it.each([
    ['malformed JSON', '{'],
    ['non-string docsRoot', JSON.stringify({ docsRoot: 42 })],
  ])('fails closed on %s active policy', async (_label, activeContents) => {
    const f = await fixture();
    await writeFile(join(f.project, '.opensquid', 'active.json'), activeContents);
    await expect(
      completeInteractiveScope({ wgId: 'wg-1', artifact: f.artifact, cwd: f.project }, deps()),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('defaults intentionally absent docsRoot to project docs', async () => {
    const f = await fixture({ packs: [] });
    const localArtifact = join(f.project, 'docs', 'research', 'scope.md');
    await mkdir(join(f.project, 'docs', 'research'), { recursive: true });
    await writeFile(localArtifact, '# local default\n');
    await expect(
      completeInteractiveScope({ wgId: 'wg-1', artifact: localArtifact, cwd: f.project }, deps()),
    ).resolves.toMatchObject({ transition: 'entered', checkpointStage: 'scope_write' });
  });

  it('rejects a non-open WorkGraph item before persistence', async () => {
    const f = await fixture();
    await expect(
      completeInteractiveScope(
        { wgId: 'wg-1', artifact: f.artifact, cwd: f.project },
        deps({ loadIssue: () => Promise.resolve({ ...issue(), status: 'in_progress' }) }),
      ),
    ).rejects.toMatchObject({ code: 'stale' });
  });
});

/**
 * T-AUTO-HANDOFF — collect.ts: totality (empty home never throws) +
 * populated-home fidelity using THIS feature's real state-file shapes.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectHandoffState, dedupeArtifactsByPath, handoverDocPath } from './collect.js';
import type { HandoffArtifact } from './collect.js';
import { sessionLogFile, sessionStateFile } from '../paths.js';
import { CheckpointStore } from '../durable/checkpoint_store.js';

let home: string;
let cwd: string;
let priorHome: string | undefined;
const SID = 'handoff-test-session-0001';

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-handoff-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'opensquid-handoff-cwd-'));
  process.env.OPENSQUID_HOME = home;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('collectHandoffState — totality', () => {
  it('on a completely EMPTY home: never throws; every probe bounded', async () => {
    const state = await collectHandoffState(SID, cwd);
    expect(state.sessionId).toBe(SID);
    expect(typeof state.fsm).toBe('string'); // <unreadable: …>
    expect(state.phaseLedger).toBe('<no active task>');
    expect(state.spawnLedgerTail).toEqual([]);
    expect(state.attestationsTail).toEqual([]);
    expect(state.artifacts).toEqual([]);
  });
});

describe('collectHandoffState — populated home (real shapes)', () => {
  it('reads FSM, active task, phase set, audit heads, ledger tail, artifact hashes', async () => {
    const stateDir = join(home, 'sessions', SID, 'state');
    await mkdir(stateDir, { recursive: true });
    await mkdir(join(home, 'sessions', SID), { recursive: true });

    // Real shapes (templates: this session's live files).
    await writeFile(
      sessionStateFile(SID, 'fsm-coding-flow'),
      JSON.stringify({
        state: 'spec_complete',
        started_at: '2026-06-10T06:36:27.445Z',
        history: [
          { state: 'scoping', at: '2026-06-10T06:36:27.445Z' },
          { state: 'researched', at: '2026-06-10T06:55:35.040Z' },
          { state: 'spec_complete', at: '2026-06-10T06:57:56.338Z' },
        ],
      }),
      'utf8',
    );
    await writeFile(
      join(home, 'sessions', SID, 'active-task.json'),
      JSON.stringify({
        id: '3',
        subject: 'X',
        started_at: 'z',
        taskId: 'T.1',
        spec: '/abs/spec.md',
      }),
      'utf8',
    );
    await writeFile(
      sessionStateFile(SID, 'workflow.phases_logged'),
      JSON.stringify({ task_id: '3', phases: ['pre_research', 'learn'] }),
      'utf8',
    );
    await writeFile(
      sessionStateFile(SID, 'coding-flow-guess-audit-cache'),
      JSON.stringify({ hash: 'h', verdict: 'VERDICT: UNRESOLVED\n\n- one open bullet here' }),
      'utf8',
    );
    await writeFile(
      sessionLogFile(SID, 'audit-spawn-ledger'),
      `${JSON.stringify({ at: 't', cache_key: 'k', model: 'reasoning', hash8: 'a', outcome: 'verdict', duration_ms: 1 })}\n`,
      'utf8',
    );
    const preResearch = join(cwd, 'pre.md');
    await writeFile(preResearch, '# pre-research content', 'utf8');
    await writeFile(
      sessionStateFile(SID, 'coding-flow-pre-research-path'),
      JSON.stringify(preResearch),
      'utf8',
    );

    const state = await collectHandoffState(SID, cwd);
    expect((state.fsm as { state: string }).state).toBe('spec_complete');
    expect((state.activeTask as { taskId?: string }).taskId).toBe('T.1');
    expect(state.guessAuditHead).toContain('UNRESOLVED');
    expect(state.spawnLedgerTail).toHaveLength(1);
    const art = state.artifacts.find((a) => a.kind === 'pre_research');
    expect(art?.path).toBe(preResearch);
    expect(art?.sha8).toMatch(/^[0-9a-f]{8}$/);
  });

  it('v2 (fullstack-flow) session: fsm + artifact come from the pack-agnostic checkpoint (no v1 keys)', async () => {
    // A v2 session writes fullstack-flow-* keys (NONE of the v1 coding-flow-* keys exist here). The
    // pack-agnostic checkpoint (keyed by wg id) carries the stage + the scope-artifact path — the handoff
    // must surface both instead of dropping them (the key-drift bug's content half).
    const artifactPath = join(cwd, 'v2-pre.md');
    await writeFile(artifactPath, '# v2 pre-research', 'utf8');

    // PLS.3: the durable checkpoint is PROJECT-LOCAL (`<root>/.opensquid/opensquid.db`). Point the store seam
    // (OPENSQUID_PROJECT_ROOT) at `home` so this write and `collectHandoffState`'s `readCheckpointBySession`
    // resolve the SAME db, instead of the retired global `home/opensquid.db`.
    const prevRoot = process.env.OPENSQUID_PROJECT_ROOT;
    process.env.OPENSQUID_PROJECT_ROOT = home;
    await mkdir(join(home, '.opensquid'), { recursive: true });
    const client = createClient({ url: `file:${join(home, '.opensquid', 'opensquid.db')}` });
    const store = new CheckpointStore(client);
    await store.init();
    await store.createTaskCheckpoint('wg-collect-v2', 'author', Date.now());
    await store.setTaskArtifacts('wg-collect-v2', [artifactPath], Date.now());
    client.close();

    const prevItem = process.env.OPENSQUID_ITEM_ID;
    process.env.OPENSQUID_ITEM_ID = 'wg-collect-v2'; // resolveCheckpointKey → this id directly (lap path)
    try {
      const state = await collectHandoffState(SID, cwd);
      expect((state.fsm as { state: string }).state).toBe('author'); // stage from the checkpoint
      const art = state.artifacts.find((a) => a.kind === 'pre_research');
      expect(art?.path).toBe(artifactPath);
      expect(art?.sha8).toMatch(/^[0-9a-f]{8}$/);
    } finally {
      if (prevItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
      else process.env.OPENSQUID_ITEM_ID = prevItem;
      if (prevRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
      else process.env.OPENSQUID_PROJECT_ROOT = prevRoot;
    }
  });

  it('V2-ENF.2/5 key-drift: reads the v2 `fullstack-flow-pre-research-path` session key (not just the v1 key)', async () => {
    // The v2 writer (v2_supply.ts) stamps `fullstack-flow-pre-research-path`; the collector historically read
    // ONLY the v1 `coding-flow-pre-research-path`, so a pure-v2 session (NO v1 key, NO checkpoint) dropped the
    // artifact on resume. This proves the v2 session-state key is now surfaced.
    await mkdir(join(home, 'sessions', SID, 'state'), { recursive: true });
    const preResearch = join(cwd, 'v2-key.md');
    await writeFile(preResearch, '# v2 pre-research', 'utf8');
    await writeFile(
      sessionStateFile(SID, 'fullstack-flow-pre-research-path'),
      JSON.stringify(preResearch),
      'utf8',
    );
    const state = await collectHandoffState(SID, cwd);
    const art = state.artifacts.find((a) => a.kind === 'pre_research');
    expect(art?.path).toBe(preResearch);
    expect(art?.sha8).toMatch(/^[0-9a-f]{8}$/);
  });

  it('V2-ENF.2/5 double-send: v1 + v2 keys pointing at the SAME path yield ONE artifact (dedup)', async () => {
    // A mixed v1→v2 session may have stamped both keys at the same file. Without the dedup the handoff would
    // double-send the identical artifact; dedupeArtifactsByPath collapses it to one.
    await mkdir(join(home, 'sessions', SID, 'state'), { recursive: true });
    const shared = join(cwd, 'shared-pre.md');
    await writeFile(shared, '# shared pre-research', 'utf8');
    for (const key of ['fullstack-flow-pre-research-path', 'coding-flow-pre-research-path']) {
      await writeFile(sessionStateFile(SID, key), JSON.stringify(shared), 'utf8');
    }
    const state = await collectHandoffState(SID, cwd);
    const preResearch = state.artifacts.filter((a) => a.kind === 'pre_research');
    expect(preResearch).toHaveLength(1);
    expect(preResearch[0]?.path).toBe(shared);
  });

  it('a cleared (empty-string) artifact-path key yields NO artifact, not a broken one (wg-4c48ef1b9969)', async () => {
    // simulate the scope_start re-arm having cleared the key to '' (or null)
    const keyPath = sessionStateFile(SID, 'coding-flow-pre-research-path');
    await mkdir(join(keyPath, '..'), { recursive: true });
    await writeFile(keyPath, JSON.stringify(''), 'utf8');
    const state = await collectHandoffState(SID, cwd);
    expect(state.artifacts.find((a) => a.kind === 'pre_research')).toBeUndefined();
  });
});

describe('helpers', () => {
  it('root falls back to cwd when there is no .opensquid/project.json marker (UCC.2)', async () => {
    // The tmp cwd has no marker → root = cwd, and the git sweep is single-repo (no umbrella members).
    const state = await collectHandoffState(SID, cwd);
    expect(state.root).toBe(cwd);
    expect(state.git.length).toBeLessThanOrEqual(1); // one repo (cwd) or none — never an umbrella set
  });
  it('handoverDocPath is keyed on sid ONLY (one doc per session — AHO.3)', () => {
    expect(handoverDocPath('/u', 'abcdefgh-rest')).toBe(
      '/u/docs/handover-session-abcdefgh-auto.md',
    );
  });

  it('dedupeArtifactsByPath keeps the FIRST occurrence per path, order-preserving (V2-ENF.2/5)', () => {
    const a = (path: string, sha8: string | null): HandoffArtifact => ({
      kind: 'pre_research',
      path,
      sha8,
    });
    const out = dedupeArtifactsByPath([
      a('/x/pre.md', 'aaaaaaaa'), // v2 read — listed first, so it wins
      a('/x/pre.md', 'bbbbbbbb'), // v1 read of the SAME file — dropped
      a('/y/spec.md', 'cccccccc'), // a distinct path — kept
    ]);
    expect(out.map((o) => o.path)).toEqual(['/x/pre.md', '/y/spec.md']);
    expect(out[0]?.sha8).toBe('aaaaaaaa'); // first-wins, not last
  });

  it('dedupeArtifactsByPath is a no-op on an already-unique / empty list', () => {
    expect(dedupeArtifactsByPath([])).toEqual([]);
    const uniq: HandoffArtifact[] = [
      { kind: 'pre_research', path: '/a', sha8: null },
      { kind: 'spec', path: '/b', sha8: null },
    ];
    expect(dedupeArtifactsByPath(uniq)).toEqual(uniq);
  });
});

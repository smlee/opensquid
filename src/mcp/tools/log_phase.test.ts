/**
 * Tests for the AP.3 `log_phase` MCP tool (retire-Rust: engine-free).
 *
 *   - resolves session (.current-session / env) + active task → writes BOTH
 *     the durable phase ledger (filesystem YAML) and the gate session-state
 *   - no live session → loud error
 *   - no active task → loud error (rule #1)
 *   - logging all 7 → complete:true
 *   - the durable ledger reads back via `readPhaseLedger` (MAU.1 "prove against
 *     reality" — now a plain filesystem round-trip, no engine).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  foldEvents,
  resetLoopStateProjectionForTest,
  tailEventsSince,
} from '../../runtime/loop/loop_events.js';

// E4: partial-mock bootstrap so `loadActiveV2Cartridges` is controllable. Default → [] (no active v2 pack →
// fail-open), so the pre-existing tests are unaffected; E4 tests opt in by setting a fullstack-flow cartridge.
vi.mock('../../runtime/bootstrap.js', async (orig) => ({
  ...(await orig()),
  loadActiveV2Cartridges: vi.fn(() => Promise.resolve([])),
}));

import { loadActiveV2Cartridges } from '../../runtime/bootstrap.js';
import { persistActorState } from '../../runtime/fsm_state.js';
import { recordCurrentSession } from '../../runtime/hooks/session_id.js';
import { readPhaseLedger } from '../../runtime/phase_ledger.js';
import { writeActiveTask } from '../../runtime/session_state.js';

import { handleLogPhase } from './log_phase.js';

// E4 — a minimal fake v2 cartridge (only the fields log_phase reads: a compiled FSM + the pack name).
const FSF_CARTRIDGE = {
  pack: { name: 'fullstack-flow' },
  compiled: { fsm: {} },
} as unknown as Awaited<ReturnType<typeof loadActiveV2Cartridges>>[number];

let tempHome: string;
let projectRoot: string;
let priorEnv: Record<string, string | undefined> = {};
const SID = 'sess-lp';

beforeEach(async () => {
  // T-MULTISESSION MS.1 — capture + clear session-resolution env so tests
  // that drive recordCurrentSession() aren't shadowed by an inherited
  // CLAUDE_SESSION_ID (the env-first resolution would prefer it).
  priorEnv = {
    OPENSQUID_HOME: process.env.OPENSQUID_HOME,
    CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    OPENSQUID_SESSION_ID: process.env.OPENSQUID_SESSION_ID,
    OPENSQUID_PROJECT_ROOT: process.env.OPENSQUID_PROJECT_ROOT,
    OPENSQUID_ITEM_ID: process.env.OPENSQUID_ITEM_ID,
  };
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-logphase-'));
  process.env.OPENSQUID_HOME = tempHome;
  // A headless ralph lap sets OPENSQUID_ITEM_ID in the env; readActiveTask uses it as a FALLBACK active task when
  // active-task.json is absent (session_state.ts:372-404). Clear it so the file-absent cases (e.g. "no active
  // task") stay hermetic; the OPENSQUID_ITEM_ID-keying cases below set it explicitly.
  delete process.env.OPENSQUID_ITEM_ID;
  // scope-1 (DPM.1) — handleLogPhase now emits a derived phase_leave monitor event via emitMonitorEvent, which
  // resolves the PROJECT-LOCAL `<root>/.opensquid/opensquid.db` (loop_db.ts:30-32, honoring only
  // OPENSQUID_PROJECT_ROOT) AND re-publishes the status-line snapshot to `<root>/.opensquid/`. Pin a temp project
  // root so the emit + snapshot land in an ISOLATED store, never the real repo db (the loop_events.test.ts idiom).
  projectRoot = await mkdtemp(join(tmpdir(), 'opensquid-logphase-proj-'));
  await mkdir(join(projectRoot, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
  resetLoopStateProjectionForTest(); // start from a cold, empty incremental projection (per-store DDL guard too)
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.OPENSQUID_SESSION_ID;
  vi.mocked(loadActiveV2Cartridges).mockResolvedValue([]); // default: no active v2 pack (fail-open)
});

afterEach(async () => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(tempHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

describe('handleLogPhase', () => {
  it('writes BOTH the durable phase ledger and the gate state for the active task', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: '15', subject: 'workflow', started_at: 'z' });

    const out = await handleLogPhase({ phase: 'pre_research', note: 'n1' });

    // (a) durable ledger — filesystem YAML, read back.
    const ledger = await readPhaseLedger('15');
    expect(ledger.phases_logged).toEqual(['pre_research']);
    expect(ledger.entries[0]).toMatchObject({ phase: 'pre_research', note: 'n1' });
    expect(typeof ledger.entries[0]?.logged_at).toBe('string');
    // (b) gate state.
    expect(out.task_id).toBe('15');
    expect(out.phases_logged).toEqual(['pre_research']);
    expect(out.complete).toBe(false);
  });

  it('reports complete:true once all 7 phases are logged', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: '15', subject: 'workflow', started_at: 'z' });
    const phases = [
      'pre_research',
      'learn',
      'code',
      'test',
      'audit',
      'post_research',
      'fix',
    ] as const;

    let out;
    for (const phase of phases) out = await handleLogPhase({ phase });

    expect(out?.complete).toBe(true);
    expect(out?.phases_logged).toHaveLength(7);
    expect((await readPhaseLedger('15')).phases_logged).toHaveLength(7);
  });

  it('throws when no env + .current-session absent (T-MULTISESSION MS.1 fallback chain end)', async () => {
    await expect(handleLogPhase({ phase: 'code' })).rejects.toThrow(/cannot resolve session/);
  });

  // T-MULTISESSION MS.1 — env-first session resolution

  it('MS.1: prefers CLAUDE_SESSION_ID env over .current-session pointer', async () => {
    process.env.CLAUDE_SESSION_ID = 'env-claude-session';
    await recordCurrentSession('pointer-session'); // would be wrong if env-first failed
    await writeActiveTask('env-claude-session', {
      id: 'task-A',
      subject: 'env-resolved',
      started_at: 'z',
    });

    const out = await handleLogPhase({ phase: 'pre_research' });

    expect(out.task_id).toBe('task-A');
    expect((await readPhaseLedger('task-A')).phases_logged).toEqual(['pre_research']);
  });

  it('MS.1: prefers OPENSQUID_SESSION_ID env when CLAUDE_SESSION_ID is absent', async () => {
    process.env.OPENSQUID_SESSION_ID = 'env-opensquid-session';
    await writeActiveTask('env-opensquid-session', {
      id: 'task-B',
      subject: 'opensquid-env-resolved',
      started_at: 'z',
    });

    const out = await handleLogPhase({ phase: 'learn' });

    expect(out.task_id).toBe('task-B');
    expect((await readPhaseLedger('task-B')).phases_logged).toEqual(['learn']);
  });

  it('MS.1: falls back to .current-session when neither env is set', async () => {
    await recordCurrentSession('pointer-only');
    await writeActiveTask('pointer-only', {
      id: 'task-C',
      subject: 'pointer-fallback',
      started_at: 'z',
    });

    const out = await handleLogPhase({ phase: 'code' });

    expect(out.task_id).toBe('task-C');
    expect((await readPhaseLedger('task-C')).phases_logged).toEqual(['code']);
  });

  it('throws when there is no active task (rule #1)', async () => {
    await recordCurrentSession(SID);
    // no writeActiveTask → active-task.json absent
    await expect(handleLogPhase({ phase: 'code' })).rejects.toThrow(/no active task/);
  });

  // E4 (docs/design/v2-enforcement-implementation.md) — couple the ledger to the per-task FSM stage.
  it('E4: REJECTS a CODE phase when the task FSM is pre-code (plan) under an active v2 pack', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: 'tE4', subject: 'wip', started_at: 'z' });
    vi.mocked(loadActiveV2Cartridges).mockResolvedValue([FSF_CARTRIDGE]);
    await persistActorState(SID, 'fullstack-flow', 'plan', 'z', 'tE4');
    await expect(handleLogPhase({ phase: 'code' })).rejects.toThrow(/not the CODE stage/);
  });

  it('E4: ALLOWS a phase once the task FSM has reached code', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: 'tE4b', subject: 'wip', started_at: 'z' });
    vi.mocked(loadActiveV2Cartridges).mockResolvedValue([FSF_CARTRIDGE]);
    await persistActorState(SID, 'fullstack-flow', 'code', 'z', 'tE4b');
    const out = await handleLogPhase({ phase: 'code' });
    expect(out.phases_logged).toEqual(['code']);
  });

  it('E4: FAIL-OPEN — v2 pack active but no per-task FSM yet → logging allowed (commit gate is the backstop)', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: 'tE4c', subject: 'wip', started_at: 'z' });
    vi.mocked(loadActiveV2Cartridges).mockResolvedValue([FSF_CARTRIDGE]);
    // no persistActorState → per-task FSM absent
    const out = await handleLogPhase({ phase: 'code' });
    expect(out.phases_logged).toEqual(['code']);
  });

  // scope-1/scope-4 (T-deterministic-phase-monitor) — the ENFORCED log_phase write DRIVES a wg-keyed phase_leave
  // (done ✓) monitor event, isolated to the temp OPENSQUID_PROJECT_ROOT loop db the beforeEach pinned.
  describe('DPM.1/DPM.4 — derived phase_leave monitor emit', () => {
    it('(a/b/d) an enforced log_phase (FSM=code) emits ONE wg-keyed phase_leave (done ✓), keyed via OPENSQUID_ITEM_ID; folds to (3/7) ✓; gate semantics preserved', async () => {
      process.env.OPENSQUID_ITEM_ID = 'wg-item'; // (b) the lap's driven item is the fallback active task + the key
      await recordCurrentSession(SID);
      // no writeActiveTask → active resolves from OPENSQUID_ITEM_ID (session_state.ts:372,402), so wgId === the env
      vi.mocked(loadActiveV2Cartridges).mockResolvedValue([FSF_CARTRIDGE]);
      await persistActorState(SID, 'fullstack-flow', 'code', 'z', 'wg-item');

      const out = await handleLogPhase({ phase: 'code' });

      // (d) gate semantics preserved alongside the new emit.
      expect(out.task_id).toBe('wg-item');
      expect(out.phases_logged).toEqual(['code']);
      expect(out.complete).toBe(false);
      // (a) exactly one derived phase_leave with the right shape (index 3 = REQUIRED_PHASES.indexOf('code')+1).
      const events = await tailEventsSince(0);
      const emitted = events.filter((e) => e.wgId === 'wg-item' && e.kind === 'phase_leave');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        wgId: 'wg-item',
        kind: 'phase_leave',
        phase: 'code',
        index: 3,
        total: 7,
        lifecycle: 'done',
      });
      // the render path (foldEvents) shows `code (3/7) ✓`, not just the raw store row.
      const [folded] = foldEvents(events).filter((s) => s.wgId === 'wg-item');
      expect(folded).toMatchObject({ phase: 'code', index: 3, total: 7, lifecycle: 'done' });
    });

    it('(c) a REJECTED pre-code phase (FSM=plan) emits NO monitor event (the E4 guard precedes the emit)', async () => {
      process.env.OPENSQUID_ITEM_ID = 'wg-pc';
      await recordCurrentSession(SID);
      vi.mocked(loadActiveV2Cartridges).mockResolvedValue([FSF_CARTRIDGE]);
      await persistActorState(SID, 'fullstack-flow', 'plan', 'z', 'wg-pc');

      await expect(handleLogPhase({ phase: 'code' })).rejects.toThrow(/not the CODE stage/);
      expect(await tailEventsSince(0)).toEqual([]);
    });

    it('(e) FAIL-OPEN — a throwing monitor store never breaks log_phase (the ledger + gate still write)', async () => {
      process.env.OPENSQUID_ITEM_ID = 'wg-fo';
      await recordCurrentSession(SID);
      vi.mocked(loadActiveV2Cartridges).mockResolvedValue([FSF_CARTRIDGE]);
      await persistActorState(SID, 'fullstack-flow', 'code', 'z', 'wg-fo');
      // Point the loop db at a project root whose `.opensquid/` does NOT exist → the libsql open/DDL throws inside
      // withLoopDb → appendMonitorEvent throws → emitMonitorEvent swallows it (monitor_emit.ts:21-30). log_phase
      // must still return ok with the ledger written (the OPENSQUID_HOME-backed ledger is unaffected).
      const badRoot = await mkdtemp(join(tmpdir(), 'opensquid-logphase-badroot-'));
      process.env.OPENSQUID_PROJECT_ROOT = badRoot; // deliberately NO .opensquid subdir

      const out = await handleLogPhase({ phase: 'code' });

      expect(out.ok).toBe(true);
      expect(out.phases_logged).toEqual(['code']);
      expect((await readPhaseLedger('wg-fo')).phases_logged).toEqual(['code']);
      await rm(badRoot, { recursive: true, force: true });
    });
  });
});

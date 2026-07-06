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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-logphase-'));
  process.env.OPENSQUID_HOME = tempHome;
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
});

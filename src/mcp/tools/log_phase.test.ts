/**
 * Tests for the AP.3 `log_phase` MCP tool.
 *
 *   - resolves session (.current-session) + active task → logs to both halves
 *   - no live session → loud error
 *   - no active task → loud error (rule #1)
 *   - logging all 7 → complete:true
 *   - REAL-ENGINE (E2E=1 + binary): log_phase persists in the engine ledger
 *     (taskGetLedger reads it back) — the MAU.1 "prove against reality" bar.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EngineClient } from '../../engine/client.js';
import { recordCurrentSession } from '../../runtime/hooks/session_id.js';
import { writeActiveTask } from '../../runtime/session_state.js';

import { handleLogPhase } from './log_phase.js';

interface LoggedCall {
  task_id: string;
  phase: string;
  note?: string;
}

/** Minimal EngineClient stub recording the taskLogPhase calls. */
function stubEngine(calls: LoggedCall[]): EngineClient {
  return {
    taskLogPhase: (p: LoggedCall) => {
      calls.push(p);
      return Promise.resolve({
        ok: true,
        task_id: p.task_id,
        phase: p.phase,
        newly_recorded: true,
      });
    },
  } as unknown as EngineClient;
}

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
});

afterEach(async () => {
  for (const [k, v] of Object.entries(priorEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe('handleLogPhase (stub engine)', () => {
  it('writes BOTH the engine ledger and the gate state for the active task', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: '15', subject: 'workflow', started_at: 'z' });
    const calls: LoggedCall[] = [];

    const out = await handleLogPhase({ phase: 'pre_research' }, stubEngine(calls));

    expect(calls).toEqual([{ task_id: '15', phase: 'pre_research' }]);
    expect(out.task_id).toBe('15');
    expect(out.phases_logged).toEqual(['pre_research']);
    expect(out.complete).toBe(false);
  });

  it('reports complete:true once all 7 phases are logged', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: '15', subject: 'workflow', started_at: 'z' });
    const engine = stubEngine([]);
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
    for (const phase of phases) out = await handleLogPhase({ phase }, engine);

    expect(out?.complete).toBe(true);
    expect(out?.phases_logged).toHaveLength(7);
  });

  it('throws when no env + .current-session absent (T-MULTISESSION MS.1 fallback chain end)', async () => {
    // No env + no recordCurrentSession → resolveMcpSessionId returns null.
    await expect(handleLogPhase({ phase: 'code' }, stubEngine([]))).rejects.toThrow(
      /cannot resolve session/,
    );
  });

  // T-MULTISESSION MS.1 — env-first session resolution

  it('MS.1: prefers CLAUDE_SESSION_ID env over .current-session pointer', async () => {
    // Both env AND .current-session set; env should win + drive resolution.
    process.env.CLAUDE_SESSION_ID = 'env-claude-session';
    await recordCurrentSession('pointer-session'); // would be wrong if env-first failed
    await writeActiveTask('env-claude-session', {
      id: 'task-A',
      subject: 'env-resolved',
      started_at: 'z',
    });

    const calls: LoggedCall[] = [];
    const out = await handleLogPhase({ phase: 'pre_research' }, stubEngine(calls));

    expect(out.task_id).toBe('task-A');
    expect(calls).toEqual([{ task_id: 'task-A', phase: 'pre_research' }]);
  });

  it('MS.1: prefers OPENSQUID_SESSION_ID env when CLAUDE_SESSION_ID is absent', async () => {
    process.env.OPENSQUID_SESSION_ID = 'env-opensquid-session';
    await writeActiveTask('env-opensquid-session', {
      id: 'task-B',
      subject: 'opensquid-env-resolved',
      started_at: 'z',
    });

    const calls: LoggedCall[] = [];
    const out = await handleLogPhase({ phase: 'learn' }, stubEngine(calls));

    expect(out.task_id).toBe('task-B');
    expect(calls).toEqual([{ task_id: 'task-B', phase: 'learn' }]);
  });

  it('MS.1: falls back to .current-session when neither env is set', async () => {
    await recordCurrentSession('pointer-only');
    await writeActiveTask('pointer-only', {
      id: 'task-C',
      subject: 'pointer-fallback',
      started_at: 'z',
    });

    const calls: LoggedCall[] = [];
    const out = await handleLogPhase({ phase: 'code' }, stubEngine(calls));

    expect(out.task_id).toBe('task-C');
    expect(calls).toEqual([{ task_id: 'task-C', phase: 'code' }]);
  });

  it('throws when there is no active task (rule #1)', async () => {
    await recordCurrentSession(SID);
    // no writeActiveTask → active-task.json absent
    await expect(handleLogPhase({ phase: 'code' }, stubEngine([]))).rejects.toThrow(
      /no active task/,
    );
  });
});

// ----- real-engine integration (MAU.1 "prove against reality" bar) ----------

const DEV_BINARY_PATH = join(
  process.env.HOME ?? '/tmp',
  'projects/loop/engine/target/release/loop-engine',
);
function isExecutable(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
const ENV_BIN = process.env.OPENSQUID_ENGINE_BIN?.trim();
const ENGINE_BIN = ENV_BIN !== undefined && ENV_BIN.length > 0 ? ENV_BIN : DEV_BINARY_PATH;
const SKIP_REAL = process.env.E2E !== '1' || !isExecutable(ENGINE_BIN);

describe.skipIf(SKIP_REAL)('handleLogPhase (real engine)', () => {
  let engineHome: string;
  let engine: EngineClient | null = null;
  let priorHomes: Record<string, string | undefined> = {};

  beforeEach(async () => {
    priorHomes = {
      OPENSQUID_HOME: process.env.OPENSQUID_HOME,
      LOOP_HOME: process.env.LOOP_HOME,
      OPENSQUID_ENGINE_BIN: process.env.OPENSQUID_ENGINE_BIN,
    };
    engineHome = await mkdtemp(join(tmpdir(), 'opensquid-logphase-engine-'));
    process.env.OPENSQUID_HOME = engineHome;
    process.env.LOOP_HOME = engineHome;
    process.env.OPENSQUID_ENGINE_BIN = ENGINE_BIN;
    engine = new EngineClient();
    await engine.ping();
  }, 30_000);

  afterEach(async () => {
    if (engine) await engine.close().catch(() => undefined);
    // best-effort: kill the spawned daemon via its pidfile if present
    spawnSync('pkill', ['-f', engineHome], { stdio: 'ignore' });
    for (const [k, v] of Object.entries(priorHomes)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(engineHome, { recursive: true, force: true });
  });

  it('persists a logged phase in the real engine ledger (read back via taskGetLedger)', async () => {
    await recordCurrentSession(SID);
    await writeActiveTask(SID, { id: 'real-15', subject: 'workflow', started_at: 'z' });

    const out = await handleLogPhase({ phase: 'pre_research', note: 'ap3 e2e' }, engine!);
    expect(out.complete).toBe(false);

    const ledger = await engine!.taskGetLedger({ task_id: 'real-15' });
    expect(ledger.phases_logged).toContain('pre_research');
    expect(ledger.entries.some((e) => e.phase === 'pre_research' && e.note === 'ap3 e2e')).toBe(
      true,
    );
  });
});

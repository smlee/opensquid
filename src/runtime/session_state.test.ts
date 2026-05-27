/**
 * Tests for the session_state tool-ledger helpers (G.5).
 *
 * Coverage:
 *   - Empty ledger read returns {turn:[], session:[]} via readSessionToolLedger
 *   - appendTool grows both turn and session lists in order
 *   - resetTurnLedger clears turn but preserves session
 *   - SESSION_LEDGER_CAP enforced via sliding-window trim on session list
 *   - Malformed JSON on disk → fresh empty ledger (no crash)
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { activeTaskFile, sessionStateFile } from './paths.js';
import {
  SESSION_LEDGER_CAP,
  type ActiveTask,
  appendTool,
  archiveActiveTask,
  clearActiveTask,
  readActiveTask,
  readSessionCwd,
  readSessionToolLedger,
  recordSessionCwd,
  resetTurnLedger,
  writeActiveTask,
} from './session_state.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-session-state-test-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('session_state tool ledger', () => {
  it('readSessionToolLedger returns empty tools when ledger is missing', async () => {
    const turn = await readSessionToolLedger('absent', 'current_turn');
    expect(turn).toEqual({ tools: [] });
    const session = await readSessionToolLedger('absent', 'session');
    expect(session).toEqual({ tools: [] });
  });

  it('appendTool grows turn + session in order', async () => {
    const sid = 'sess-grow';
    await appendTool(sid, 'Bash');
    await appendTool(sid, 'Read');

    const turn = await readSessionToolLedger(sid, 'current_turn');
    const session = await readSessionToolLedger(sid, 'session');

    expect(turn.tools).toEqual(['Bash', 'Read']);
    expect(session.tools).toEqual(['Bash', 'Read']);
  });

  it('resetTurnLedger clears turn slice but preserves session slice', async () => {
    const sid = 'sess-reset';
    await appendTool(sid, 'Bash');
    await appendTool(sid, 'Read');
    await resetTurnLedger(sid);

    const turn = await readSessionToolLedger(sid, 'current_turn');
    const session = await readSessionToolLedger(sid, 'session');

    expect(turn.tools).toEqual([]);
    expect(session.tools).toEqual(['Bash', 'Read']);
  });

  it('trims session list to SESSION_LEDGER_CAP on overflow', async () => {
    const sid = 'sess-cap';
    const total = SESSION_LEDGER_CAP + 5;
    for (let i = 0; i < total; i++) {
      await appendTool(sid, `T${String(i)}`);
    }

    const session = await readSessionToolLedger(sid, 'session');
    expect(session.tools.length).toBe(SESSION_LEDGER_CAP);
    // Oldest 5 dropped (T0..T4); most-recent kept.
    expect(session.tools[0]).toBe('T5');
    expect(session.tools[session.tools.length - 1]).toBe(`T${String(total - 1)}`);
  });

  it('falls back to empty ledger when on-disk JSON is malformed', async () => {
    const sid = 'sess-corrupt';
    const path = sessionStateFile(sid, 'tool-ledger');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not valid json', 'utf8');

    const turn = await readSessionToolLedger(sid, 'current_turn');
    expect(turn).toEqual({ tools: [] });
  });
});

describe('session cwd pointer (MAU.3)', () => {
  it('round-trips a recorded cwd', async () => {
    await recordSessionCwd('sid-cwd', '/Users/x/projects/loop');
    expect(await readSessionCwd('sid-cwd')).toBe('/Users/x/projects/loop');
  });

  it('returns null when no cwd was recorded', async () => {
    expect(await readSessionCwd('sid-absent')).toBeNull();
  });

  it('overwrites a prior cwd (latest wins)', async () => {
    await recordSessionCwd('sid-cwd', '/first');
    await recordSessionCwd('sid-cwd', '/second');
    expect(await readSessionCwd('sid-cwd')).toBe('/second');
  });
});

describe('active-task signal (AP.2)', () => {
  const full: ActiveTask = {
    id: '15',
    subject: 'Automate the 7-layer workflow',
    started_at: '2026-05-27T00:00:00.000Z',
    taskId: 'AP',
    spec: 'docs/tasks/T-automation-pipeline.md',
  };

  it('round-trips a full active task incl. provenance', async () => {
    await writeActiveTask('sid-at', full);
    expect(await readActiveTask('sid-at')).toEqual(full);
  });

  it('round-trips a minimal task (no provenance fields)', async () => {
    const min: ActiveTask = { id: '7', subject: 'x', started_at: '2026-05-27T01:00:00.000Z' };
    await writeActiveTask('sid-min', min);
    const read = await readActiveTask('sid-min');
    expect(read).toEqual(min);
    expect(read).not.toHaveProperty('taskId'); // absent optional stays absent (not undefined-keyed)
  });

  it('returns null when no active task exists', async () => {
    expect(await readActiveTask('sid-none')).toBeNull();
  });

  it('returns null on malformed JSON (no throw inside a hook bin)', async () => {
    const path = activeTaskFile('sid-bad');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', 'utf8');
    expect(await readActiveTask('sid-bad')).toBeNull();
  });

  it('returns null when a required field is missing', async () => {
    const path = activeTaskFile('sid-partial');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ id: '1', subject: 'no started_at' }), 'utf8');
    expect(await readActiveTask('sid-partial')).toBeNull();
  });

  it('clear removes the signal; subsequent read is null', async () => {
    await writeActiveTask('sid-clear', full);
    await clearActiveTask('sid-clear');
    expect(await readActiveTask('sid-clear')).toBeNull();
  });

  it('clear on an absent signal does not throw', async () => {
    await expect(clearActiveTask('sid-clear-absent')).resolves.toBeUndefined();
  });

  it('archive renames the signal (rule #16 — trace preserved, not deleted)', async () => {
    await writeActiveTask('sid-arch', full);
    await archiveActiveTask('sid-arch');
    // Live signal gone:
    expect(await readActiveTask('sid-arch')).toBeNull();
    // …but an archived copy remains in the session dir:
    const dir = dirname(activeTaskFile('sid-arch'));
    const archived = (await readdir(dir)).filter(
      (f) => f.startsWith('active-task.') && f.endsWith('.archived.json'),
    );
    expect(archived).toHaveLength(1);
  });

  it('archive on an absent signal is a no-op (does not throw)', async () => {
    await expect(archiveActiveTask('sid-arch-absent')).resolves.toBeUndefined();
  });
});

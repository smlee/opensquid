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
  advanceSkillTicks,
  appendTool,
  archiveActiveTask,
  clearActiveTask,
  clearSkillTicks,
  isReadOnlyBash,
  readActiveTask,
  readSessionCwd,
  readSessionToolLedger,
  readSkillTicks,
  recordSessionCwd,
  resetScopeWindow,
  resetTurnLedger,
  writeActiveTask,
} from './session_state.js';
import type { Event } from './types.js';

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

  it('appendTool grows sinceScope; readSessionToolLedger(since_scope_start) returns it (wg-3e241144f441)', async () => {
    const sid = 'sess-since';
    await appendTool(sid, 'mcp__opensquid__recall');
    await appendTool(sid, 'Read');
    const since = await readSessionToolLedger(sid, 'since_scope_start');
    expect(since.tools).toEqual(['mcp__opensquid__recall', 'Read']);
  });

  it('resetTurnLedger preserves sinceScope (research survives turn boundaries)', async () => {
    const sid = 'sess-since-turn';
    await appendTool(sid, 'Read');
    await resetTurnLedger(sid);
    expect((await readSessionToolLedger(sid, 'current_turn')).tools).toEqual([]);
    expect((await readSessionToolLedger(sid, 'since_scope_start')).tools).toEqual(['Read']);
  });

  it('resetScopeWindow clears sinceScope but PRESERVES turn + session', async () => {
    const sid = 'sess-since-reset';
    await appendTool(sid, 'Read');
    await appendTool(sid, 'mcp__opensquid__recall');
    await resetScopeWindow(sid);
    expect((await readSessionToolLedger(sid, 'since_scope_start')).tools).toEqual([]);
    expect((await readSessionToolLedger(sid, 'current_turn')).tools).toEqual([
      'Read',
      'mcp__opensquid__recall',
    ]);
    expect((await readSessionToolLedger(sid, 'session')).tools).toEqual([
      'Read',
      'mcp__opensquid__recall',
    ]);
  });

  it('a ledger JSON missing sinceScope reads as [] (backward-compatible)', async () => {
    const sid = 'sess-since-bc';
    const path = sessionStateFile(sid, 'tool-ledger');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ turn: ['Read'], session: ['Read'] }), 'utf8');
    expect((await readSessionToolLedger(sid, 'since_scope_start')).tools).toEqual([]);
    // and a subsequent append populates it without throwing
    await appendTool(sid, 'mcp__opensquid__recall');
    expect((await readSessionToolLedger(sid, 'since_scope_start')).tools).toEqual([
      'mcp__opensquid__recall',
    ]);
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

  it('appendTool records an additive Bash:read-only token for read-only Bash only', async () => {
    const sid = 'sess-ro';
    await appendTool(sid, 'Bash', 'grep foo file.ts');
    await appendTool(sid, 'Bash', 'pnpm build');
    await appendTool(sid, 'Read');
    await appendTool(sid, 'Bash'); // no command → just Bash

    const turn = (await readSessionToolLedger(sid, 'current_turn')).tools;
    // read-only Bash → BOTH tokens, in order; mutating/no-command Bash → just Bash
    expect(turn).toEqual(['Bash', 'Bash:read-only', 'Bash', 'Read', 'Bash']);
  });
});

describe('isReadOnlyBash classifier', () => {
  it('accepts allowlisted read-only commands (incl. pipelines)', () => {
    for (const cmd of [
      'grep foo f',
      'rg -n foo',
      'cat a | grep b',
      "find . -name '*.ts'",
      'head -5 f',
      'ls -la',
      "sed -n '1,5p' f",
      'cat f | jq .x | head',
    ]) {
      expect(isReadOnlyBash(cmd), cmd).toBe(true);
    }
  });

  it('rejects mutating / build / redirect / unknown commands (fail-closed)', () => {
    for (const cmd of [
      'pnpm build',
      'git commit -m x',
      'npm install',
      'rm f',
      'mv a b',
      'sed -i s/a/b/ f',
      'find . -delete',
      'find . -exec rm {} \\;',
      'echo x > f',
      'cat a > b',
      'grep foo f && rm f',
      '',
    ]) {
      expect(isReadOnlyBash(cmd), cmd).toBe(false);
    }
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

  // scope-4 (deploy-commit-gate §4) — the headless-lap item fallback (injected, never ambient env).
  it('resolves the lap item when no on-disk signal AND lapItemId is supplied (id === taskId)', async () => {
    const t = await readActiveTask('sid-lap-none', 'wg-a32d43367f52');
    expect(t?.id).toBe('wg-a32d43367f52');
    expect(t?.taskId).toBe('wg-a32d43367f52'); // every keying path (gate.active.id, readActiveTaskId) agrees
    expect(t?.subject).toBe('wg-a32d43367f52');
    expect(typeof t?.started_at).toBe('string');
  });

  it('falls back to the lap item even on malformed JSON', async () => {
    const path = activeTaskFile('sid-lap-bad');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', 'utf8');
    expect((await readActiveTask('sid-lap-bad', 'wg-x'))?.id).toBe('wg-x');
  });

  it('a REAL on-disk signal WINS over the lap item fallback', async () => {
    await writeActiveTask('sid-lap-file', full);
    expect(await readActiveTask('sid-lap-file', 'wg-ignored')).toEqual(full);
  });

  it('blank/whitespace lapItemId is treated as absent → null (no fallback)', async () => {
    expect(await readActiveTask('sid-lap-blank', '   ')).toBeNull();
    expect(await readActiveTask('sid-lap-undef', undefined)).toBeNull();
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

// ---------------------------------------------------------------------------
// Per-skill tick state (CU.1)
//
// The tick map is the persisted backing for `unloads_when`. The load-bearing
// property is CROSS-PROCESS persistence: each hook bin is a fresh process, so
// two sequential `advanceSkillTicks` calls (simulating two hook processes over
// the same OPENSQUID_HOME) must accumulate — the second read sees the first's
// count, +1. The shape is `Record<skillId, TickState>` with the TickState
// imported from `unload_conditions.ts` (single source).
// ---------------------------------------------------------------------------

describe('per-skill tick state (CU.1)', () => {
  const promptSubmit: Event = { kind: 'prompt_submit', prompt: 'go' };
  const stop: Event = { kind: 'stop', assistantText: 'done' };
  const sessionEnd: Event = { kind: 'session_end', sessionId: 'tick-edge' };

  it('advance writes a fresh tick (createTick → advance) and round-trips', async () => {
    const sid = 'tick-fresh';
    await advanceSkillTicks(sid, promptSubmit, ['a']);
    const read = await readSkillTicks(sid);
    expect(read).toEqual({
      a: { turnsSinceActivation: 1, taskCompleted: false, sessionEnded: false },
    });
  });

  it('persists across two sequential calls (cross-process: count accumulates)', async () => {
    const sid = 'tick-cross-process';
    // First "hook process".
    await advanceSkillTicks(sid, promptSubmit, ['a']);
    // Second "hook process" — reads the prior count off disk, +1.
    const after = await advanceSkillTicks(sid, promptSubmit, ['a']);
    expect(after.a?.turnsSinceActivation).toBe(2);
    expect(await readSkillTicks(sid)).toEqual({
      a: { turnsSinceActivation: 2, taskCompleted: false, sessionEnded: false },
    });
  });

  it('reactivated skill resets its tick (createTick then advance → 1)', async () => {
    const sid = 'tick-reactivate';
    await advanceSkillTicks(sid, promptSubmit, ['a']);
    await advanceSkillTicks(sid, promptSubmit, ['a']); // now at 2
    const after = await advanceSkillTicks(sid, promptSubmit, ['a'], new Set(['a']));
    // Reset to fresh then advance once → 1 (NOT 3).
    expect(after.a?.turnsSinceActivation).toBe(1);
  });

  it('a skill dropped from loadedSkillIds is removed from the new map', async () => {
    const sid = 'tick-drop';
    await advanceSkillTicks(sid, promptSubmit, ['a', 'b']);
    const after = await advanceSkillTicks(sid, promptSubmit, ['a']); // b no longer loaded
    expect(after).toHaveProperty('a');
    expect(after).not.toHaveProperty('b');
    expect(await readSkillTicks(sid)).not.toHaveProperty('b');
  });

  it('newly-loaded skill (no prior tick) gets a fresh tick', async () => {
    const sid = 'tick-new';
    await advanceSkillTicks(sid, promptSubmit, ['a']); // a at 1
    const after = await advanceSkillTicks(sid, promptSubmit, ['a', 'b']); // b first seen
    expect(after.a?.turnsSinceActivation).toBe(2);
    expect(after.b?.turnsSinceActivation).toBe(1); // fresh
  });

  it('stop event latches taskCompleted; session_end latches sessionEnded', async () => {
    const sid = 'tick-edge';
    const afterStop = await advanceSkillTicks(sid, stop, ['a']);
    expect(afterStop.a?.taskCompleted).toBe(true);
    expect(afterStop.a?.turnsSinceActivation).toBe(0); // stop is not a turn boundary
    const afterEnd = await advanceSkillTicks(sid, sessionEnd, ['a']);
    expect(afterEnd.a?.sessionEnded).toBe(true);
  });

  it('readSkillTicks returns {} for an absent file', async () => {
    expect(await readSkillTicks('tick-absent')).toEqual({});
  });

  it('readSkillTicks returns {} on malformed JSON (no throw)', async () => {
    const sid = 'tick-corrupt';
    const path = sessionStateFile(sid, 'skill-ticks');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not valid json', 'utf8');
    expect(await readSkillTicks(sid)).toEqual({});
  });

  it('readSkillTicks drops a per-entry malformed value, keeps the valid ones', async () => {
    const sid = 'tick-partial';
    const path = sessionStateFile(sid, 'skill-ticks');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        good: { turnsSinceActivation: 2, taskCompleted: false, sessionEnded: false },
        bad: { turnsSinceActivation: 'nope' },
      }),
      'utf8',
    );
    const read = await readSkillTicks(sid);
    expect(read).toHaveProperty('good');
    expect(read).not.toHaveProperty('bad');
  });

  it('clearSkillTicks removes the map; subsequent read is {}', async () => {
    const sid = 'tick-clear';
    await advanceSkillTicks(sid, promptSubmit, ['a']);
    await clearSkillTicks(sid);
    expect(await readSkillTicks(sid)).toEqual({});
  });

  it('clearSkillTicks on an absent file does not throw', async () => {
    await expect(clearSkillTicks('tick-clear-absent')).resolves.toBeUndefined();
  });
});

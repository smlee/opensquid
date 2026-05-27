/**
 * Tests for the AP.3 phase state machine (pure, no engine).
 *
 * Coverage:
 *   - appendPhase accumulates + dedupes phases for a task
 *   - switching active task resets the ledger (no inheritance)
 *   - isComplete: false until all 7 REQUIRED present; false for a stale task_id
 *   - readPhaseState null on absent / malformed
 */

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sessionStateFile } from './paths.js';
import {
  REQUIRED_PHASES,
  appendPhase,
  isComplete,
  readPhaseState,
  type PhaseState,
} from './workflow_phases.js';

let tempHome: string;
let priorHome: string | undefined;
const SID = 'sess-wf';

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-wf-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('workflow phase state machine (AP.3)', () => {
  it('accumulates phases for a task and dedupes re-logs', async () => {
    await appendPhase(SID, '15', 'pre_research');
    await appendPhase(SID, '15', 'learn');
    const state = await appendPhase(SID, '15', 'pre_research'); // re-log
    expect(state).toEqual({ task_id: '15', phases: ['pre_research', 'learn'] });
  });

  it('resets the ledger when the active task changes', async () => {
    await appendPhase(SID, '15', 'pre_research');
    await appendPhase(SID, '15', 'learn');
    const switched = await appendPhase(SID, '16', 'pre_research');
    expect(switched).toEqual({ task_id: '16', phases: ['pre_research'] });
  });

  it('isComplete is false until all 7 REQUIRED phases are present', async () => {
    let state: PhaseState | null = null;
    for (const p of REQUIRED_PHASES.slice(0, 6)) state = await appendPhase(SID, '15', p);
    expect(isComplete(state, '15')).toBe(false);
    state = await appendPhase(SID, '15', 'fix'); // the 7th
    expect(isComplete(state, '15')).toBe(true);
  });

  it('isComplete is false when the ledger is for a different (stale) task', async () => {
    let state: PhaseState | null = null;
    for (const p of REQUIRED_PHASES) state = await appendPhase(SID, '15', p);
    expect(isComplete(state, '15')).toBe(true);
    // A new task is active now → the prior task's completion must NOT carry over.
    expect(isComplete(state, '16')).toBe(false);
  });

  it('isComplete is false on a null ledger', () => {
    expect(isComplete(null, '15')).toBe(false);
  });

  it('readPhaseState returns null when absent', async () => {
    expect(await readPhaseState('sess-absent')).toBeNull();
  });

  it('readPhaseState returns null on malformed JSON', async () => {
    const path = sessionStateFile('sess-bad', 'workflow.phases_logged');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', 'utf8');
    expect(await readPhaseState('sess-bad')).toBeNull();
  });
});

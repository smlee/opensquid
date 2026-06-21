import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GOAL_STATE_KEY, readGoalState, writeGoalState, type GoalState } from './goal_state.js';
import { sessionStateFile } from './paths.js';

const SID = 'sess-goal-test';

const sample: GoalState = {
  id: 'goal-abc123',
  text: 'ship GS.1',
  status: 'active',
  createdAt: '2026-06-20T00:00:00.000Z',
  updatedAt: '2026-06-20T00:00:00.000Z',
};

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-goal-state-test-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('goal_state', () => {
  it('returns null when no goal is set', async () => {
    expect(await readGoalState(SID)).toBeNull();
  });

  it('round-trips a written goal', async () => {
    await writeGoalState(SID, sample);
    expect(await readGoalState(SID)).toEqual(sample);
  });

  it('overwrites on a second write (last write wins)', async () => {
    await writeGoalState(SID, sample);
    const next: GoalState = { ...sample, text: 'updated', updatedAt: '2026-06-20T01:00:00.000Z' };
    await writeGoalState(SID, next);
    expect(await readGoalState(SID)).toEqual(next);
  });

  it('returns null on malformed JSON (never throws)', async () => {
    const file = sessionStateFile(SID, GOAL_STATE_KEY);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{ not valid json', 'utf8');
    expect(await readGoalState(SID)).toBeNull();
  });

  it('returns null on a shape mismatch', async () => {
    const file = sessionStateFile(SID, GOAL_STATE_KEY);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ id: 'x', text: 'y' }), 'utf8');
    expect(await readGoalState(SID)).toBeNull();
  });
});

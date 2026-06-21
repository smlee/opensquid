import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordSessionCwd, writeActiveTask } from '../session_state.js';
import { readGoalMap, writeGoalMap, type GoalMap } from './goal_map.js';
import { observeGoalTransition } from './observe.js';

const NOW = '2026-06-21T00:00:00.000Z';
const SESSION = 'sess-goalmap-observe';
const goal = (): GoalMap => ({ goal: 'ship X', createdAt: NOW, claim: null, worksheets: [] });

describe('GOAL-MAPPER.2 — observeGoalTransition (the per-slice trigger)', () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), 'osq-gm-obs-'));
    await mkdir(join(proj, '.opensquid'), { recursive: true });
    await recordSessionCwd(SESSION, proj); // the session's cwd → the goal-map home
  });
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true });
  });

  it('to===scoping with a goal-map → appends ONE worksheet (sliceId=now, goalRef=goal)', async () => {
    await writeGoalMap(proj, goal());
    await observeGoalTransition({ session: SESSION, to: 'scoping', now: NOW });
    const gm = await readGoalMap(proj);
    expect(gm?.worksheets).toEqual([{ sliceId: NOW, startedAt: NOW, goalRef: 'ship X' }]);
  });

  it('no goal-map → no-op (surfaced, not blocked)', async () => {
    await observeGoalTransition({ session: SESSION, to: 'scoping', now: NOW });
    expect(await readGoalMap(proj)).toBeNull();
  });

  it('to other than scoping/tasks_loaded → no-op', async () => {
    await writeGoalMap(proj, goal());
    await observeGoalTransition({ session: SESSION, to: 'phases_complete', now: NOW });
    expect((await readGoalMap(proj))?.worksheets).toEqual([]);
  });

  it('to===tasks_loaded links the active taskId onto the open worksheet', async () => {
    await writeGoalMap(proj, goal());
    await observeGoalTransition({ session: SESSION, to: 'scoping', now: NOW }); // open a worksheet
    await writeActiveTask(SESSION, { id: '15', subject: 's', started_at: NOW, taskId: 'GM.2' });
    await observeGoalTransition({ session: SESSION, to: 'tasks_loaded', now: NOW });
    expect((await readGoalMap(proj))?.worksheets[0]?.taskId).toBe('GM.2');
  });
});

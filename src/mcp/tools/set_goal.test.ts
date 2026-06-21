import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readGoalState } from '../../runtime/goal_state.js';

import { handleSetGoal } from './set_goal.js';

const SESSION_ENVS = [
  'CLAUDE_SESSION_ID',
  'OPENSQUID_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
] as const;

const deps = { now: () => '2026-06-20T12:00:00.000Z', genId: () => 'goal-fixed' };

let tempHome: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  saved.OPENSQUID_HOME = process.env.OPENSQUID_HOME;
  for (const k of SESSION_ENVS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-set-goal-test-'));
  process.env.OPENSQUID_HOME = tempHome;
  process.env.OPENSQUID_SESSION_ID = 'sess-1';
});

afterEach(async () => {
  for (const k of [...SESSION_ENVS, 'OPENSQUID_HOME']) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe('handleSetGoal', () => {
  it('mints a goal on first set and persists it', async () => {
    const out = await handleSetGoal({ text: 'ship it', status: 'active' }, deps);
    expect(out).toEqual({
      id: 'goal-fixed',
      text: 'ship it',
      status: 'active',
      createdAt: '2026-06-20T12:00:00.000Z',
      updatedAt: '2026-06-20T12:00:00.000Z',
    });
    expect(await readGoalState('sess-1')).toEqual(out);
  });

  it('updates in place: keeps id + createdAt, bumps updatedAt', async () => {
    await handleSetGoal({ text: 'first', status: 'active' }, deps);
    const out = await handleSetGoal(
      { text: 'second', status: 'completed' },
      { now: () => '2026-06-20T13:00:00.000Z', genId: () => 'goal-should-not-be-used' },
    );
    expect(out.id).toBe('goal-fixed');
    expect(out.createdAt).toBe('2026-06-20T12:00:00.000Z');
    expect(out.updatedAt).toBe('2026-06-20T13:00:00.000Z');
    expect(out.text).toBe('second');
    expect(out.status).toBe('completed');
  });

  it('preserves existing status on a text-only update (no default-reset)', async () => {
    await handleSetGoal({ text: 'first', status: 'completed' }, deps);
    const out = await handleSetGoal({ text: 'edited' }, { now: () => '2026-06-20T14:00:00.000Z' });
    expect(out.status).toBe('completed'); // NOT reset to 'active'
    expect(out.text).toBe('edited');
    expect(out.id).toBe('goal-fixed');
    expect(out.createdAt).toBe('2026-06-20T12:00:00.000Z');
    expect(out.updatedAt).toBe('2026-06-20T14:00:00.000Z');
  });

  it('defaults to active on first set when status omitted', async () => {
    const out = await handleSetGoal({ text: 'fresh' }, deps);
    expect(out.status).toBe('active');
  });

  it('throws when no session can be resolved', async () => {
    delete process.env.OPENSQUID_SESSION_ID;
    await expect(handleSetGoal({ text: 'x', status: 'active' }, deps)).rejects.toThrow(
      /cannot resolve session/,
    );
  });
});

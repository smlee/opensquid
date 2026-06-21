import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleGetGoal } from './get_goal.js';
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
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-get-goal-test-'));
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

describe('handleGetGoal', () => {
  it('returns null when no goal is set', async () => {
    expect(await handleGetGoal()).toBeNull();
  });

  it('returns the goal after it has been set', async () => {
    await handleSetGoal({ text: 'browse classes', status: 'active' }, deps);
    expect(await handleGetGoal()).toMatchObject({
      id: 'goal-fixed',
      text: 'browse classes',
      status: 'active',
    });
  });

  it('returns null when no session can be resolved', async () => {
    delete process.env.OPENSQUID_SESSION_ID;
    expect(await handleGetGoal()).toBeNull();
  });
});

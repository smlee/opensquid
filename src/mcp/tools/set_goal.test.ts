import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readGoalMap } from '../../runtime/goal_map/goal_map.js';
import { recordSessionCwd } from '../../runtime/session_state.js';
import { handleSetGoal } from './set_goal.js';

const SESSION = 'sess-set-goal';
const NOW = new Date('2026-06-21T00:00:00.000Z');

describe('GOAL-MAPPER.2 — set_goal MCP tool', () => {
  let proj: string;
  let prevEnv: string | undefined;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), 'osq-setgoal-'));
    await mkdir(join(proj, '.opensquid'), { recursive: true });
    await recordSessionCwd(SESSION, proj);
    prevEnv = process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = SESSION; // resolveMcpSessionId is env-first
  });
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = prevEnv;
    await rm(proj, { recursive: true, force: true });
  });

  it('writes the goal (single source of truth) + claims the goal-map for the session', async () => {
    const out = await handleSetGoal({ goal: 'make the statement live-true' }, NOW);
    expect(out).toEqual({ ok: true, goal: 'make the statement live-true' });
    const gm = await readGoalMap(proj);
    expect(gm?.goal).toBe('make the statement live-true');
    expect(gm?.claim?.sessionId).toBe(SESSION);
  });

  it('updating the goal preserves existing worksheets + re-claims', async () => {
    await handleSetGoal({ goal: 'first goal' }, NOW);
    const updated = await handleSetGoal({ goal: 'revised goal' }, NOW);
    expect(updated.goal).toBe('revised goal');
    expect((await readGoalMap(proj))?.goal).toBe('revised goal');
  });
});

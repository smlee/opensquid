import { mkdtemp, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type GoalMap,
  claimGoalMap,
  readGoalMap,
  reassignGoalMap,
  writeGoalMap,
} from './goal_map.js';

const NOW = new Date('2026-06-21T00:00:00.000Z');
const fresh = (): GoalMap => ({
  goal: 'ship the v2 cutover',
  createdAt: NOW.toISOString(),
  claim: null,
  worksheets: [],
});

describe('GOAL-MAPPER.1 — goal_map store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osq-goalmap-'));
  });
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips in a project dir (path = <project>/.opensquid/goal-map.json)', async () => {
    await mkdir(join(dir, '.opensquid'), { recursive: true });
    const gm = fresh();
    await writeGoalMap(dir, gm);
    // deterministic: dir has a `.opensquid` dir → that IS the project scope root
    await expect(stat(join(dir, '.opensquid', 'goal-map.json'))).resolves.toBeDefined();
    expect(await readGoalMap(dir)).toEqual(gm);
  });

  it('reads null when no goal-map exists yet', async () => {
    await mkdir(join(dir, '.opensquid'), { recursive: true });
    expect(await readGoalMap(dir)).toBeNull();
  });

  it('write→read round-trips (user-scope fallback when no project)', async () => {
    // no `.opensquid` in `dir` → resolveProjectScopeRoot may fall back to user scope; round-trip holds.
    const gm = fresh();
    await writeGoalMap(dir, gm);
    expect(await readGoalMap(dir)).toEqual(gm);
  });
});

describe('GOAL-MAPPER.1 — claim / reassign (pure)', () => {
  it('claimGoalMap sets the claim and does not mutate the input', () => {
    const gm = fresh();
    const next = claimGoalMap(gm, 's1', NOW);
    expect(next.claim).toEqual({ sessionId: 's1', at: NOW.toISOString() });
    expect(gm.claim).toBeNull(); // input unmutated
  });

  it('reassign to the SAME session, or from a null claim, succeeds without force', () => {
    expect(reassignGoalMap(fresh(), 's1', NOW, { force: false }).claim?.sessionId).toBe('s1');
    const owned = claimGoalMap(fresh(), 's1', NOW);
    expect(reassignGoalMap(owned, 's1', NOW, { force: false }).claim?.sessionId).toBe('s1');
  });

  it('reassign to a DIFFERENT session THROWS without force, succeeds with force', () => {
    const owned = claimGoalMap(fresh(), 's1', NOW);
    expect(() => reassignGoalMap(owned, 's2', NOW, { force: false })).toThrow(/requires force/);
    expect(reassignGoalMap(owned, 's2', NOW, { force: true }).claim?.sessionId).toBe('s2');
  });
});

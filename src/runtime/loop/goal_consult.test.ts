import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { appendAsk } from '../coverage/captured_ask.js';
import { writeGoalMap } from '../goal_map/goal_map.js';
import { goalConsult } from './goal_consult.js';

// T2.10 — the deterministic, advisory goal-map destination check at SCOPE.
describe('goalConsult — T2.10 goal-map consultation', () => {
  const gm = (goal: string) => ({
    goal,
    createdAt: '2026-06-26T00:00:00.000Z',
    claim: null,
    worksheets: [],
  });

  // A project-SCOPED temp root (the `.opensquid` marker) so each test's goal map is isolated — without it
  // goalMapPath falls back to the SHARED user scope and tests collide.
  const newRoot = async (slug: string): Promise<string> => {
    const cwd = await mkdtemp(join(tmpdir(), slug));
    await mkdir(join(cwd, '.opensquid'), { recursive: true });
    return cwd;
  };

  it('no goal map → { hasGoal:false, aligned:true } (absence is not a drift signal)', async () => {
    const cwd = await newRoot('goal-none-');
    const r = await goalConsult('sess-goal-none', cwd);
    expect(r).toEqual({ hasGoal: false, aligned: true, goal: '' });
  });

  it('an empty goal string → not a drift signal', async () => {
    const cwd = await newRoot('goal-empty-');
    await writeGoalMap(cwd, gm(''));
    const r = await goalConsult('sess-goal-empty', cwd);
    expect(r.hasGoal).toBe(false);
    expect(r.aligned).toBe(true);
  });

  it('a goal whose salient tokens appear in the captured ask → aligned:true', async () => {
    const cwd = await newRoot('goal-aligned-');
    const sid = 'sess-goal-aligned';
    await writeGoalMap(cwd, gm('Build the deterministic discipline gates'));
    await appendAsk(sid, 'please build the discipline gates for v2');
    const r = await goalConsult(sid, cwd);
    expect(r.hasGoal).toBe(true);
    expect(r.aligned).toBe(true); // "discipline"/"gates" appear in the ask
    expect(r.goal).toBe('Build the deterministic discipline gates');
  });

  it('a goal disjoint from the captured ask → aligned:false (destination drift)', async () => {
    const cwd = await newRoot('goal-drift-');
    const sid = 'sess-goal-drift';
    await writeGoalMap(cwd, gm('Migrate the billing subsystem to Stripe'));
    await appendAsk(sid, 'tweak the homepage banner colors');
    const r = await goalConsult(sid, cwd);
    expect(r.hasGoal).toBe(true);
    expect(r.aligned).toBe(false); // none of billing/migrate/stripe/subsystem in the ask
  });

  it('a goal of only short tokens (none > 4 chars) → aligned:true (no salient token to check)', async () => {
    const cwd = await newRoot('goal-short-');
    const sid = 'sess-goal-short';
    await writeGoalMap(cwd, gm('do it now'));
    await appendAsk(sid, 'something entirely unrelated');
    const r = await goalConsult(sid, cwd);
    expect(r.aligned).toBe(true); // tokens.length === 0 → aligned
  });

  it('is deterministic — same disk state yields the same verdict', async () => {
    const cwd = await newRoot('goal-det-');
    const sid = 'sess-goal-det';
    await writeGoalMap(cwd, gm('Ship the portability export pipeline'));
    await appendAsk(sid, 'work on the export pipeline');
    expect(await goalConsult(sid, cwd)).toEqual(await goalConsult(sid, cwd));
  });
});

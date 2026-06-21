import { describe, expect, it } from 'vitest';

import type { GoalMap } from './goal_map.js';
import { startWorksheet } from './mapper.js';

const NOW = new Date('2026-06-21T00:00:00.000Z');
const gm = (): GoalMap => ({
  goal: 'ship the v2 cutover',
  createdAt: NOW.toISOString(),
  claim: null,
  worksheets: [],
});

describe('GOAL-MAPPER.1 — per-slice mapper', () => {
  it('startWorksheet appends a goal-anchored checkpoint keyed by sliceId(=taskId)', () => {
    const next = startWorksheet(gm(), 'T-7', 'build the goal-map store', NOW);
    expect(next.worksheets).toEqual([
      {
        sliceId: 'T-7',
        startedAt: NOW.toISOString(),
        goalRef: 'ship the v2 cutover', // snapshot of the goal — the anti-drift anchor
        intent: 'build the goal-map store',
      },
    ]);
  });

  it('is PURE (does not mutate the input) and ORDERS worksheets', () => {
    const base = gm();
    const a = startWorksheet(base, 'T-1', 'slice one', NOW);
    const b = startWorksheet(a, 'T-2', 'slice two', NOW);
    expect(base.worksheets).toEqual([]); // input unmutated
    expect(b.worksheets.map((w) => w.sliceId)).toEqual(['T-1', 'T-2']); // ordered, per-slice
  });
});

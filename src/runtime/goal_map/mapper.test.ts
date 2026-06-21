import { describe, expect, it } from 'vitest';

import type { GoalMap } from './goal_map.js';
import { linkTaskId, startWorksheet } from './mapper.js';

const NOW = '2026-06-21T00:00:00.000Z';
const gm = (): GoalMap => ({
  goal: 'ship the v2 cutover',
  createdAt: NOW,
  claim: null,
  worksheets: [],
});

describe('GOAL-MAPPER — per-slice mapper', () => {
  it('startWorksheet appends a goal-anchored checkpoint keyed by sliceId (no intent; now is ISO string)', () => {
    const next = startWorksheet(gm(), 'slice-1', NOW);
    expect(next.worksheets).toEqual([
      { sliceId: 'slice-1', startedAt: NOW, goalRef: 'ship the v2 cutover' },
    ]);
  });

  it('is PURE (does not mutate the input) and ORDERS worksheets', () => {
    const base = gm();
    const a = startWorksheet(base, 's1', NOW);
    const b = startWorksheet(a, 's2', NOW);
    expect(base.worksheets).toEqual([]);
    expect(b.worksheets.map((w) => w.sliceId)).toEqual(['s1', 's2']);
  });

  it('linkTaskId sets taskId on the most-recent worksheet lacking one (single-track slice)', () => {
    const two = startWorksheet(startWorksheet(gm(), 's1', NOW), 's2', NOW);
    const linked = linkTaskId(two, 'T-42');
    expect(linked.worksheets[1]?.taskId).toBe('T-42'); // the latest open one
    expect(linked.worksheets[0]?.taskId).toBeUndefined();
    expect(two.worksheets[1]?.taskId).toBeUndefined(); // input unmutated
  });

  it('linkTaskId no-ops when there is no open (taskId-less) worksheet', () => {
    const linked = linkTaskId(linkTaskId(startWorksheet(gm(), 's1', NOW), 'T-1'), 'T-2');
    expect(linked.worksheets.map((w) => w.taskId)).toEqual(['T-1']); // second link finds none open → no-op
  });
});

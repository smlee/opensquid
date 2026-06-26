import { describe, expect, it } from 'vitest';

import { type Edge, batchDecide } from './batch_decide.js';

// T2.14 — the deterministic batch-vs-isolate decision over work-graph edges (pre-research §3).
describe('batchDecide — T2.14 batch-vs-isolate', () => {
  it('independent issues (no blocks edge) → all parallel, none sequential', () => {
    const plan = batchDecide(['a', 'b', 'c'], []);
    expect(plan.parallel).toEqual(['a', 'b', 'c']);
    expect(plan.sequential).toEqual([]);
    expect(plan.batches).toEqual([]);
  });

  it('a blocks chain → the blocked issue is sequential', () => {
    const edges: Edge[] = [{ from: 'a', to: 'b', type: 'blocks' }];
    const plan = batchDecide(['a', 'b'], edges);
    expect(plan.parallel).toEqual(['a']); // a has no blocker
    expect(plan.sequential).toEqual(['b']); // b is blocked by a
  });

  it('two independent siblings under one parent-child parent → one batch group', () => {
    const edges: Edge[] = [
      { from: 'p', to: 'x', type: 'parent-child' },
      { from: 'p', to: 'y', type: 'parent-child' },
    ];
    const plan = batchDecide(['x', 'y'], edges);
    expect(plan.parallel).toEqual(['x', 'y']);
    expect(plan.batches).toEqual([['x', 'y']]);
  });

  it('groups discovered-from siblings the same as parent-child', () => {
    const edges: Edge[] = [
      { from: 'root', to: 'd1', type: 'discovered-from' },
      { from: 'root', to: 'd2', type: 'discovered-from' },
    ];
    const plan = batchDecide(['d1', 'd2'], edges);
    expect(plan.batches).toEqual([['d1', 'd2']]);
  });

  it('a lone child (single sibling) is NOT a batch', () => {
    const edges: Edge[] = [{ from: 'p', to: 'only', type: 'parent-child' }];
    const plan = batchDecide(['only'], edges);
    expect(plan.batches).toEqual([]); // need >1 sibling to batch
  });

  it('a blocked sibling is excluded from its parent batch (axis-1 gates axis-2)', () => {
    const edges: Edge[] = [
      { from: 'p', to: 'x', type: 'parent-child' },
      { from: 'p', to: 'y', type: 'parent-child' },
      { from: 'x', to: 'y', type: 'blocks' }, // y blocked → not parallel → not batched
    ];
    const plan = batchDecide(['x', 'y'], edges);
    expect(plan.parallel).toEqual(['x']);
    expect(plan.sequential).toEqual(['y']);
    expect(plan.batches).toEqual([]); // only x is parallel under p → single sibling, no batch
  });

  it('a `related` edge does NOT create a parent grouping (only parent-child/discovered-from do)', () => {
    const edges: Edge[] = [
      { from: 'a', to: 'b', type: 'related' },
      { from: 'b', to: 'a', type: 'related' },
    ];
    const plan = batchDecide(['a', 'b'], edges);
    expect(plan.batches).toEqual([]);
  });

  it('is deterministic — same input twice yields an identical plan', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const edges: Edge[] = [
      { from: 'p', to: 'a', type: 'parent-child' },
      { from: 'p', to: 'b', type: 'parent-child' },
      { from: 'a', to: 'c', type: 'blocks' },
    ];
    expect(batchDecide(ids, edges)).toEqual(batchDecide(ids, edges));
  });
});

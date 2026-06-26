/** T2.5 — planAudit (Kahn acyclic + completeness over the independent universe) + buildCoveredBy JOIN. */
import { describe, expect, it } from 'vitest';

import { buildCoveredBy, planAudit, type PlanInput } from './plan_audit.js';

const base: PlanInput = { issueIds: [], edges: [], designElementIds: [], coveredBy: {} };

describe('planAudit — acyclic (Kahn over blocks+parent-child)', () => {
  it('an acyclic blocks chain → acyclic:true, no cycles', () => {
    const r = planAudit({
      ...base,
      issueIds: ['a', 'b', 'c'],
      edges: [
        { from: 'a', to: 'b', type: 'blocks' },
        { from: 'b', to: 'c', type: 'parent-child' },
      ],
    });
    expect(r.acyclic).toBe(true);
    expect(r.cycles).toEqual([]);
  });

  it('a blocks CYCLE → acyclic:false and names the residual nodes', () => {
    const r = planAudit({
      ...base,
      issueIds: ['a', 'b', 'c'],
      edges: [
        { from: 'a', to: 'b', type: 'blocks' },
        { from: 'b', to: 'c', type: 'blocks' },
        { from: 'c', to: 'a', type: 'blocks' },
      ],
    });
    expect(r.acyclic).toBe(false);
    expect(r.cycles.sort()).toEqual(['a', 'b', 'c']);
  });

  it('non-dependency edge types (related/discovered-from) do NOT create a cycle', () => {
    const r = planAudit({
      ...base,
      issueIds: ['a', 'b'],
      edges: [
        { from: 'a', to: 'b', type: 'related' },
        { from: 'b', to: 'a', type: 'discovered-from' },
      ],
    });
    expect(r.acyclic).toBe(true);
  });

  it('zero edges → vacuously acyclic', () => {
    expect(planAudit({ ...base, issueIds: ['a', 'b'] }).acyclic).toBe(true);
  });
});

describe('planAudit — complete (independent universe)', () => {
  it('every design element covered → complete:true', () => {
    const r = planAudit({
      ...base,
      designElementIds: ['scope-1', 'scope-2'],
      coveredBy: { 'scope-1': ['wg-1'], 'scope-2': ['wg-2'] },
    });
    expect(r.complete).toBe(true);
    expect(r.uncovered).toEqual([]);
  });

  it('an uncovered element → complete:false and names it', () => {
    const r = planAudit({
      ...base,
      designElementIds: ['scope-1', 'scope-2'],
      coveredBy: { 'scope-1': ['wg-1'], 'scope-2': [] },
    });
    expect(r.complete).toBe(false);
    expect(r.uncovered).toEqual(['scope-2']);
  });

  it('a design element absent from coveredBy entirely → uncovered (fail-closed)', () => {
    const r = planAudit({ ...base, designElementIds: ['scope-9'], coveredBy: {} });
    expect(r.complete).toBe(false);
    expect(r.uncovered).toEqual(['scope-9']);
  });
});

describe('planAudit — determinism', () => {
  it('same input twice → identical report', () => {
    const input: PlanInput = {
      issueIds: ['a', 'b', 'c'],
      edges: [
        { from: 'a', to: 'b', type: 'blocks' },
        { from: 'b', to: 'c', type: 'blocks' },
      ],
      designElementIds: ['scope-1', 'scope-2'],
      coveredBy: { 'scope-1': ['a'], 'scope-2': [] },
    };
    expect(planAudit(input)).toEqual(planAudit(input));
  });
});

describe('buildCoveredBy — the deterministic JOIN', () => {
  it('groups issues by their stamped sourceElementId', () => {
    const cov = buildCoveredBy(
      ['scope-1', 'scope-2'],
      [
        { id: 'wg-a', body: 'sourceElementId:scope-1' },
        { id: 'wg-b', body: 'sourceElementId:scope-1' },
        { id: 'wg-c', body: 'sourceElementId:scope-2' },
      ],
    );
    expect(cov).toEqual({ 'scope-1': ['wg-a', 'wg-b'], 'scope-2': ['wg-c'] });
  });

  it('an unstamped issue (no sourceElementId) covers nothing', () => {
    const cov = buildCoveredBy(['scope-1'], [{ id: 'wg-x', body: 'no stamp here' }]);
    expect(cov).toEqual({ 'scope-1': [] });
  });

  it('a stamp for an element NOT in the universe is ignored (independent universe)', () => {
    const cov = buildCoveredBy(['scope-1'], [{ id: 'wg-y', body: 'sourceElementId:scope-7' }]);
    expect(cov).toEqual({ 'scope-1': [] });
  });
});

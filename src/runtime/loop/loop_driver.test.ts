/**
 * T2.9 / RD.2 — `onPhasesComplete` loop-driver tests (zero LLM, deterministic).
 *
 * Covers: (1) the CODE after report body is RETURNED (byte-unchanged 7-phase ledger) and NO `.opensquid/reports/`
 * file is written (RD.4 removed the disk save — the caller DISPLAYS the returned body live); (2) the returned
 * next run-group matches `batchDecide` — independent issues → singletons, sibling batch → one group. Uses a stub
 * `LoopWorkGraph` (no real store / no DB) + a temp dir, with an injected `iso`.
 */
import { describe, expect, it } from 'vitest';

import { mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge } from './batch_decide.js';
import { onPhasesComplete, type LoopWorkGraph } from './loop_driver.js';

const ISO = '2026-06-22T13:45:07.000Z';

function stubWg(readyIds: string[], edges: Edge[]): LoopWorkGraph {
  return {
    listReadyIds: () => Promise.resolve(readyIds),
    listEdges: () => Promise.resolve(edges),
  };
}

describe('onPhasesComplete (T2.9 loop driver)', () => {
  it('RETURNS the CODE after body (7-phase ledger) and writes NO .opensquid/reports/ file (RD.2/RD.4)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-driver-'));
    const scope = join(root, '.opensquid');
    await mkdir(scope, { recursive: true }); // a project marker exists — yet NO report file may be written now
    const { report: body } = await onPhasesComplete('sid-1', root, 'T-code', stubWg([], []), ISO);
    // RD.2 — the CODE after body is RETURNED (displayed live by the caller), byte-unchanged.
    expect(body).toContain('After-stage report — CODE complete · T-code · 2026-06-22');
    expect(body).not.toContain('🦑'); // reports never use the drift/gate glyph (design §4)
    // the long, stand-out CODE report: the 7-phase step chart
    expect(body).toContain('Phases:');
    expect(body).toContain('[x] pre_research');
    expect(body).toContain('[x] fix');
    expect(body).toContain('Next → deploy:');
    // the gate-evidence line (the CODE predicates that passed)
    expect(body).toContain('Evidence: phases_complete ✓ · readiness_ran ✓ · deprecated_clean ✓');
    // CODE report carries NO goal line (only SCOPE does — T2.10).
    expect(body).not.toContain('Goal:');
    // RD.4 — the COMMUNICATION report is DISPLAYED, never filed: no reports dir was created.
    await expect(readdir(join(scope, 'reports'))).rejects.toThrow(); // ENOENT — no file written
  });

  it('independent ready issues → each its own singleton run-group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-driver-'));
    const r = await onPhasesComplete('sid-2', root, 'T-x', stubWg(['a', 'b', 'c'], []), ISO);
    expect(r.next).toEqual([['a'], ['b'], ['c']]);
  });

  it('independent sibling leaves under one parent → one batched run-group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-driver-'));
    // p is the parent; a + b are its independent children (parent-child edges) → batchDecide groups them.
    const edges: Edge[] = [
      { from: 'p', to: 'a', type: 'parent-child' },
      { from: 'p', to: 'b', type: 'parent-child' },
    ];
    const r = await onPhasesComplete('sid-3', root, 'T-y', stubWg(['a', 'b'], edges), ISO);
    expect(r.next).toEqual([['a', 'b']]);
  });

  it('a blocked issue is sequential — only the unblocked one is a ready singleton', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-driver-'));
    // `a blocks b` → b is sequential (not parallel); only `a` is an independent singleton run-group.
    const edges: Edge[] = [{ from: 'a', to: 'b', type: 'blocks' }];
    const r = await onPhasesComplete('sid-4', root, 'T-z', stubWg(['a', 'b'], edges), ISO);
    expect(r.next).toEqual([['a']]);
  });
});

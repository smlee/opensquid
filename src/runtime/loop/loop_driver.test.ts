/**
 * T2.9 — `onPhasesComplete` loop-driver tests (zero LLM, deterministic).
 *
 * Covers: (1) the CODE stage report file is SAVED under a TEMP project's .opensquid/reports/ (V2-ENF.2/4 —
 * (2) the returned next run-group matches `batchDecide` — independent issues → singletons, sibling batch →
 * one group. Uses a stub `LoopWorkGraph` (no real store / no DB) + a temp dir, with an injected `iso`.
 */
import { describe, expect, it } from 'vitest';

import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
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
  it('emits the CODE stage report file under the project reports dir (the AF.3 per-task report)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-driver-'));
    await mkdir(join(root, '.opensquid'), { recursive: true }); // project marker → saveProjectReport resolves
    await onPhasesComplete('sid-1', root, 'T-code', stubWg([], []), ISO);
    // V2-ENF.2/4 — SAVED under `<project>/.opensquid/reports/`, never the legacy `docs/reports/`.
    const path = join(root, '.opensquid', 'reports', 'code-T-code-2026-06-22.md');
    const body = await readFile(path, 'utf8');
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

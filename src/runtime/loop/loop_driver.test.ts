/**
 * T2.9 — `onPhasesComplete` loop-driver tests (zero LLM, deterministic).
 *
 * Covers: (1) the CODE stage report file is emitted under a TEMP root (never the real repo docs/reports/);
 * (2) the returned next run-group matches `batchDecide` — independent issues → singletons, sibling batch →
 * one group. Uses a stub `LoopWorkGraph` (no real store / no DB) + a temp dir, with an injected `iso`.
 */
import { describe, expect, it } from 'vitest';

import { mkdtemp, readFile } from 'node:fs/promises';
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
  it('emits the CODE stage report file under the given root (the AF.3 per-task report)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-driver-'));
    await onPhasesComplete('sid-1', root, 'T-code', stubWg([], []), ISO);
    const path = join(root, 'docs/reports', 'code-T-code-2026-06-22.md');
    const body = await readFile(path, 'utf8');
    expect(body).toContain('# CODE report — T-code (2026-06-22T13:45:07.000Z)');
    expect(body).toContain('## Summary\nphases complete');
    expect(body).toContain('## Next\nnext task');
    // CODE report carries NO goal-alignment line (only SCOPE does — T2.10).
    expect(body).not.toContain('## Goal alignment');
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

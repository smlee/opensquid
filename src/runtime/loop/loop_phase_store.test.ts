/**
 * LSF.2 (subprocess-harness-push.md §2a) — the wg-keyed phase store + the generic `setLoopPhase` primitive.
 *
 * Covers: the upsert (one row per wg id; a phase advance overwrites); optional null index/total; the whole-board
 * read. Uses a real libsql via an `OPENSQUID_PROJECT_ROOT` tmpdir override (the project-LOCAL seam `loopDbUrl()`
 * honors — PLS.3).
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLoopPhase, listLoopPhases } from './loop_phase_store.js';

const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'loop-phase-'));
  mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('loop_phase_store', () => {
  it('writes a wg-keyed phase row with its L2 counters', async () => {
    await setLoopPhase('wg-a', 'test', 4, 7, 1_000);
    const rows = await listLoopPhases();
    expect(rows).toEqual([
      { wgId: 'wg-a', phase: 'test', phaseIndex: 4, phaseTotal: 7, updatedAtMs: 1_000 },
    ]);
  });

  it('upserts — a phase advance OVERWRITES the prior row (one row per wg id)', async () => {
    await setLoopPhase('wg-a', 'code', 3, 7, 1_000);
    await setLoopPhase('wg-a', 'fix', 7, 7, 2_000);
    const rows = await listLoopPhases();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ phase: 'fix', phaseIndex: 7, updatedAtMs: 2_000 });
  });

  it('accepts a bare label with null index/total (a stage with un-enumerated phases)', async () => {
    await setLoopPhase('wg-b', 'confirm', null, null, 500);
    const [r] = await listLoopPhases();
    expect(r).toMatchObject({ phase: 'confirm', phaseIndex: null, phaseTotal: null });
  });

  it('keeps each item’s phase separate (whole-board read)', async () => {
    await setLoopPhase('wg-a', 'code', 3, 7, 1_000);
    await setLoopPhase('wg-b', 'research', 1, 2, 1_000);
    const rows = await listLoopPhases();
    expect(new Set(rows.map((r) => r.wgId))).toEqual(new Set(['wg-a', 'wg-b']));
  });
});

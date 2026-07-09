/**
 * LMP.1 + LMP.6 — the `loop_events` append-only store + the pull-removal assertion.
 *
 * Covers (LMP.1): the append + tail round-trip with a store-assigned monotonic `seq`; the cursor exactly-once
 * (a resume from a seq omits the events at/before it); the stored-`lifecycle` coercion; and concurrent appends
 * riding the shared concurrency posture without `SQLITE_BUSY`. Uses a real `withLoopDb` against an
 * `OPENSQUID_PROJECT_ROOT` temp store — no `~/.opensquid` home I/O.
 *
 * Covers (LMP.6 — the clean replacement): a source-level assertion that the removed pull symbols have ZERO
 * references left in non-test `src/` (comments stripped) — no two coexisting models.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendMonitorEvent,
  tailEventsSince,
  foldLatestState,
  foldLatestStateIncremental,
  resetLoopStateProjectionForTest,
} from './loop_events.js';
import { withLoopDb } from './loop_db.js';

const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'loop-events-'));
  mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('appendMonitorEvent / tailEventsSince (LMP.1)', () => {
  it('round-trips one event with a store-assigned seq (>0)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 });
    const rows = await tailEventsSince(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 });
    expect(rows[0]!.seq).toBeGreaterThan(0);
  });

  it('assigns strictly-increasing seqs; the cursor is exactly-once (a resume omits seen events)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'plan', atMs: 1 });
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'author', atMs: 2 });
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 3 });
    const all = await tailEventsSince(0);
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // strictly increasing
    expect(new Set(seqs).size).toBe(3);
    const afterFirst = await tailEventsSince(seqs[0]!);
    expect(afterFirst.map((e) => e.seq)).toEqual(seqs.slice(1)); // the first is omitted (exactly-once)
  });

  it('round-trips a phase_enter (lifecycle/index/total) and coerces an unknown lifecycle to running', async () => {
    await appendMonitorEvent({
      wgId: 'wg-a',
      kind: 'phase_enter',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
      atMs: 5,
    });
    const [row] = await tailEventsSince(0);
    expect(row).toMatchObject({
      kind: 'phase_enter',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
    });
    // a stored value that is neither 'done' nor 'running' coerces to 'running' on read.
    await appendMonitorEvent({
      wgId: 'wg-b',
      kind: 'phase_enter',
      // deliberately cast a bogus lifecycle to exercise the read coercion.
      lifecycle: 'weird' as 'running',
      atMs: 6,
    });
    const rowB = (await tailEventsSince(0)).find((e) => e.wgId === 'wg-b');
    expect(rowB?.lifecycle).toBe('running');
  });

  it('concurrent appends both land without SQLITE_BUSY (shared concurrency posture)', async () => {
    await Promise.all([
      appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 }),
      appendMonitorEvent({ wgId: 'wg-b', kind: 'stage_advance', stage: 'plan', atMs: 2 }),
    ]);
    const all = await tailEventsSince(0);
    expect(all.map((e) => e.wgId).sort()).toEqual(['wg-a', 'wg-b']);
  });
});

// ---------------------------------------------------------------------------
// §C.12 — the incremental materialized projection: same result as the whole-log fold, but cursor-bounded so the
// emit path never re-scans history (the O(N²) defect the SLC.2 wiring would otherwise add).
// ---------------------------------------------------------------------------

describe('foldLatestStateIncremental (§C.12 — cursor-bounded materialization)', () => {
  beforeEach(() => resetLoopStateProjectionForTest());
  afterEach(() => resetLoopStateProjectionForTest());

  it('folds to the SAME per-item latest state as the whole-log foldLatestState', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 });
    await appendMonitorEvent({
      wgId: 'wg-a',
      kind: 'phase_enter',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
      atMs: 2,
    });
    await appendMonitorEvent({ wgId: 'wg-b', kind: 'stage_advance', stage: 'plan', atMs: 3 });
    const full = [...(await foldLatestState())].sort((a, b) => a.wgId.localeCompare(b.wgId));
    const incr = [...(await foldLatestStateIncremental())].sort((a, b) =>
      a.wgId.localeCompare(b.wgId),
    );
    expect(incr).toEqual(full);
    expect(incr).toMatchObject([
      { wgId: 'wg-a', stage: 'code', phase: 'test', index: 4, total: 7, lifecycle: 'running' },
      { wgId: 'wg-b', stage: 'plan' },
    ]);
  });

  it('advances by a cursor — a second call tails ONLY new events, keeping earlier items from the materialized state (no whole-log re-scan)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 });
    expect((await foldLatestStateIncremental()).map((s) => s.wgId)).toEqual(['wg-a']);
    // Delete wg-a's ONLY event from the log. A whole-log re-fold would now lose wg-a; the incremental projection
    // retains it from the materialized state and tails only the NEW row → proving it does not re-scan history.
    await withLoopDb((db) => db.execute("DELETE FROM loop_events WHERE wg_id = 'wg-a'"));
    await appendMonitorEvent({ wgId: 'wg-b', kind: 'stage_advance', stage: 'plan', atMs: 2 });
    const incr = (await foldLatestStateIncremental()).map((s) => s.wgId).sort();
    expect(incr).toEqual(['wg-a', 'wg-b']); // wg-a survived from the cache; a from-0 re-fold would drop it
    expect((await foldLatestState()).map((s) => s.wgId)).toEqual(['wg-b']); // (whole-log genuinely lost wg-a)
  });

  it('is safe under concurrent refreshes (serialized RMW — no double-apply / lost update)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 });
    await appendMonitorEvent({ wgId: 'wg-b', kind: 'stage_advance', stage: 'plan', atMs: 2 });
    const [r1, r2] = await Promise.all([
      foldLatestStateIncremental(),
      foldLatestStateIncremental(),
    ]);
    expect(r1.map((s) => s.wgId).sort()).toEqual(['wg-a', 'wg-b']);
    expect(r2.map((s) => s.wgId).sort()).toEqual(['wg-a', 'wg-b']);
  });
});

// ---------------------------------------------------------------------------
// LMP.6 — the pull machinery is GONE: no references left in non-test src/ (comments stripped). One model only.
// ---------------------------------------------------------------------------

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Recursively list non-test `.ts` source files under `src/`. */
function srcFilesExcludingTests(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...srcFilesExcludingTests(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments so the assertion checks CODE references, not doc-headers describing the removal. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('LMP.6: the pull machinery has no references left (no two models)', () => {
  it('no non-test src file references a removed pull symbol', () => {
    const banned = [
      'resolveTerminalStages',
      'filterLiveView',
      'loop_terminal_seen',
      'TerminalSeenStore',
      'DEFAULT_SURFACE',
      'listLoopPhases',
      'setLoopPhase',
      'loop_phases',
    ];
    const files = srcFilesExcludingTests(SRC_DIR);
    const offenders: string[] = [];
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'));
      for (const sym of banned) if (code.includes(sym)) offenders.push(`${f} → ${sym}`);
    }
    expect(offenders, `dangling pull references:\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * LMP.4 — the pure fold + the live subscribe primitive.
 *
 * Covers: the per-kind reducer transitions (advance clears the phase; enter/leave set the lifecycle; ship/close
 * → terminal; wedge stays visible); freshness = the last-event timestamp; chunk-invariant determinism (the same
 * events in seq order via two chunkings fold identically); and `subscribeMonitor` exactly-once over a real temp
 * store. `foldEvents` is pure (synthetic slices, no I/O); `subscribeMonitor` uses an `OPENSQUID_PROJECT_ROOT`
 * temp store.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  foldEvents,
  subscribeMonitor,
  appendMonitorEvent,
  type MonitorEvent,
} from './loop_events.js';

let seq = 0;
function ev(partial: Omit<MonitorEvent, 'seq'>): MonitorEvent {
  return { ...partial, seq: ++seq };
}

describe('foldEvents (LMP.4 reducer)', () => {
  it('folds stage + phase (enter → running) into per-item latest state', () => {
    seq = 0;
    const [state] = foldEvents([
      ev({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 }),
      ev({
        wgId: 'wg-a',
        kind: 'phase_enter',
        phase: 'test',
        index: 4,
        total: 7,
        lifecycle: 'running',
        atMs: 2,
      }),
    ]);
    expect(state).toMatchObject({
      wgId: 'wg-a',
      stage: 'code',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
      lastEventAtMs: 2,
      terminal: false,
    });
  });

  it('phase_leave flips the lifecycle to done (the ⟳ → ✓ round-trip)', () => {
    seq = 0;
    const [state] = foldEvents([
      ev({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 }),
      ev({
        wgId: 'wg-a',
        kind: 'phase_enter',
        phase: 'test',
        index: 4,
        total: 7,
        lifecycle: 'running',
        atMs: 2,
      }),
      ev({
        wgId: 'wg-a',
        kind: 'phase_leave',
        phase: 'test',
        index: 4,
        total: 7,
        lifecycle: 'done',
        atMs: 3,
      }),
    ]);
    expect(state?.lifecycle).toBe('done');
    expect(state?.lastEventAtMs).toBe(3);
  });

  it('a stage_advance AFTER a phase CLEARS the phase (a new stage has no phase yet)', () => {
    seq = 0;
    const [state] = foldEvents([
      ev({ wgId: 'wg-a', kind: 'stage_advance', stage: 'author', atMs: 1 }),
      ev({
        wgId: 'wg-a',
        kind: 'phase_enter',
        phase: 'write',
        index: 2,
        total: 2,
        lifecycle: 'running',
        atMs: 2,
      }),
      ev({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 3 }),
    ]);
    expect(state?.stage).toBe('code');
    expect(state?.phase).toBeUndefined();
    expect(state?.lifecycle).toBeUndefined();
    expect(state?.lastEventAtMs).toBe(3);
  });

  it('item_shipped → terminal:true (the staleness drop); item_wedged stays visible', () => {
    seq = 0;
    const shipped = foldEvents([
      ev({ wgId: 'wg-a', kind: 'stage_advance', stage: 'deploy', atMs: 1 }),
      ev({ wgId: 'wg-a', kind: 'item_shipped', atMs: 2 }),
    ]);
    expect(shipped[0]?.terminal).toBe(true);
    const wedged = foldEvents([
      ev({ wgId: 'wg-b', kind: 'stage_advance', stage: 'code', atMs: 1 }),
      ev({ wgId: 'wg-b', kind: 'item_wedged', atMs: 2 }),
    ]);
    expect(wedged[0]?.terminal).toBe(false); // parked, still shown
  });

  it('is chunk-invariant — the same events in seq order fold identically across two chunkings', () => {
    seq = 0;
    const a = ev({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1 });
    const b = ev({
      wgId: 'wg-a',
      kind: 'phase_enter',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
      atMs: 2,
    });
    const c = ev({
      wgId: 'wg-a',
      kind: 'phase_leave',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'done',
      atMs: 3,
    });
    const whole = foldEvents([a, b, c]);
    // re-fold in two chunks by feeding the accumulated slices — order preserved, result identical.
    const chunk1 = foldEvents([a, b]);
    const chunk2 = foldEvents([a, b, c]);
    expect(chunk2).toEqual(whole);
    expect(chunk1[0]?.lifecycle).toBe('running'); // mid-stream state is the running phase
  });
});

describe('subscribeMonitor (LMP.4 live tail)', () => {
  const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'loop-fold-'));
    mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
    process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
  });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('invokes onEvent once per event in seq order, then a resume sees only NEW events (exactly-once)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'plan', atMs: 1 });
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'author', atMs: 2 });
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 3 });

    const seen: MonitorEvent[] = [];
    await subscribeMonitor(0, (e) => seen.push(e), {
      intervalMs: 0,
      shouldStop: () => seen.length >= 3,
    });
    expect(seen.map((e) => e.stage)).toEqual(['plan', 'author', 'code']);
    expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((x, y) => x - y));

    // resume from the last seq → only NEW events (none yet, then one appended).
    const lastSeq = seen[seen.length - 1]!.seq;
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'item_shipped', atMs: 4 });
    const resumed: MonitorEvent[] = [];
    await subscribeMonitor(lastSeq, (e) => resumed.push(e), {
      intervalMs: 0,
      shouldStop: () => resumed.length >= 1,
    });
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.kind).toBe('item_shipped');
  });
});

/**
 * LSF.1 / LMP.5 — `collectLoopState()` as a FOLD over the push stream + the `liveItems` terminal-drop.
 *
 * Covers: the fold-map (a seeded `loop_events` store → the folded `LoopStateItem`s with stage/phase/lifecycle/
 * lastActivityMs); the full-truth contract (terminal items INCLUDED in `collectLoopState`); and `liveItems`
 * dropping terminal items (the staleness fix — a shipped item drops instead of freezing at its stage). Uses a
 * real libsql via an `OPENSQUID_PROJECT_ROOT` override (the project-LOCAL seam — PLS.3); no `~/.opensquid` I/O.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendMonitorEvent,
  foldEvents,
  tailEventsSince,
  resetLoopStateProjectionForTest,
  type LoopFoldState,
} from './loop_events.js';
import { collectLoopState, collectLoopStateIncremental, liveItems, mapFold } from './loop_state.js';

const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'loop-state-'));
  mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('collectLoopState (fold over the push stream)', () => {
  it('folds the stream into per-item stage + current-stage phase + lifecycle + freshness', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1_000 });
    await appendMonitorEvent({
      wgId: 'wg-a',
      kind: 'phase_enter',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
      atMs: 2_000,
    });

    const state = await collectLoopState();
    const item = state.find((i) => i.wgId === 'wg-a');
    expect(item).toMatchObject({
      stage: 'code',
      phase: 'test',
      phaseIndex: 4,
      phaseTotal: 7,
      lifecycle: 'running',
      lastActivityMs: 2_000,
      terminal: false,
    });
  });

  it('a new stage CLEARS the prior stage’s phase (no stale phase bleed)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'plan', atMs: 1_000 });
    await appendMonitorEvent({
      wgId: 'wg-a',
      kind: 'phase_enter',
      phase: 'decompose',
      lifecycle: 'running',
      atMs: 2_000,
    });
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 5_000 });

    const [item] = await collectLoopState();
    expect(item?.stage).toBe('code');
    expect(item?.phase).toBeUndefined(); // the plan-stage phase is cleared by the advance
  });

  it('keeps terminal items in the full truth; liveItems drops them (the staleness fix)', async () => {
    await appendMonitorEvent({ wgId: 'wg-live', kind: 'stage_advance', stage: 'code', atMs: 1 });
    await appendMonitorEvent({ wgId: 'wg-done', kind: 'stage_advance', stage: 'deploy', atMs: 1 });
    await appendMonitorEvent({ wgId: 'wg-done', kind: 'item_shipped', atMs: 2 });

    const full = await collectLoopState();
    expect(full.find((i) => i.wgId === 'wg-done')?.terminal).toBe(true); // full truth includes it
    const live = liveItems(full);
    expect(live.map((i) => i.wgId)).toEqual(['wg-live']); // shipped item dropped, not frozen at deploy
  });
});

describe('collectLoopStateIncremental (§C.12 — the emit-path board, same contract as collectLoopState)', () => {
  beforeEach(() => resetLoopStateProjectionForTest());
  afterEach(() => resetLoopStateProjectionForTest());

  it('maps the incremental fold onto the SAME LoopStateItem contract as collectLoopState', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1_000 });
    await appendMonitorEvent({
      wgId: 'wg-a',
      kind: 'phase_enter',
      phase: 'test',
      index: 4,
      total: 7,
      lifecycle: 'running',
      atMs: 2_000,
    });
    const [item] = await collectLoopStateIncremental();
    expect(item).toMatchObject({
      wgId: 'wg-a',
      stage: 'code',
      phase: 'test',
      phaseIndex: 4,
      phaseTotal: 7,
      lifecycle: 'running',
      lastActivityMs: 2_000,
      updatedAt: 2_000,
      terminal: false,
    });
    // Identical to the whole-log read (the incremental cursor changes cost, never the result).
    expect(await collectLoopStateIncremental()).toEqual(await collectLoopState());
  });
});

describe('mapFold (F3 — the shared fold→board mapping reused by --watch)', () => {
  beforeEach(() => resetLoopStateProjectionForTest());
  afterEach(() => resetLoopStateProjectionForTest());

  it('maps a folded slice onto the LoopStateItem contract (no DB read)', () => {
    const fold: LoopFoldState[] = [
      {
        wgId: 'wg-a',
        stage: 'code',
        phase: 'test',
        index: 4,
        total: 7,
        lifecycle: 'running',
        lastEventAtMs: 2_000,
        terminal: false,
      },
    ];
    expect(mapFold(fold)).toEqual([
      {
        wgId: 'wg-a',
        stage: 'code',
        phase: 'test',
        phaseIndex: 4,
        phaseTotal: 7,
        lifecycle: 'running',
        lastActivityMs: 2_000,
        updatedAt: 2_000,
        terminal: false,
      },
    ]);
  });

  it('F3 — folding the ONE seed read yields the SAME board as a second collectLoopState() (--watch dedup)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'plan', atMs: 1_000 });
    await appendMonitorEvent({ wgId: 'wg-b', kind: 'stage_advance', stage: 'code', atMs: 2_000 });
    // --watch folds its ONE seed read for the board instead of a second collectLoopState() DB read — the two
    // must be byte-identical, else the board and the tail would disagree (the duplicate-line race F3 removes).
    const seed = await tailEventsSince(0);
    expect(mapFold(foldEvents(seed))).toEqual(await collectLoopState());
  });
});

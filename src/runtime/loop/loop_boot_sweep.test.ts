/**
 * F1c (post-ship logic fixes §3.7 element 1c) — the one-time boot backlog sweep.
 *
 * Proves the DROP-WITHOUT-EVENT half of F1: an item that folds LIVE on the feed but reads wg-terminal (a close
 * that landed with no monitor event — the harness-sync reconcile close, or a pre-fix / crash-window close) gets
 * a synthetic `item_closed` so it drops off the feed. Uses a real libsql via an `OPENSQUID_PROJECT_ROOT` override
 * (the project-LOCAL seam) + a fake set-based `BootSweepReader`; no `~/.opensquid` I/O.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendMonitorEvent, resetLoopStateProjectionForTest } from './loop_events.js';
import { collectLoopState, liveItems } from './loop_state.js';
import { sweepTerminalBacklog, type BootSweepReader } from './loop_boot_sweep.js';
import type { Issue, IssueStatus } from '../../workgraph/types.js';

const savedRoot = process.env.OPENSQUID_PROJECT_ROOT;
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'loop-boot-sweep-'));
  mkdirSync(join(projectRoot, '.opensquid'), { recursive: true });
  process.env.OPENSQUID_PROJECT_ROOT = projectRoot;
  resetLoopStateProjectionForTest();
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = savedRoot;
  rmSync(projectRoot, { recursive: true, force: true });
  resetLoopStateProjectionForTest();
});

/** A fake reader that returns a fixed set of terminal-status issues (the sweep filters by status itself). */
const readerOf = (terminal: { id: string; status: IssueStatus }[]): BootSweepReader => ({
  listIssues: (filter) =>
    Promise.resolve(
      terminal
        .filter((t) => filter?.status === undefined || t.status === filter.status)
        .map(
          (t): Issue => ({
            id: t.id,
            title: t.id,
            body: '',
            status: t.status,
            createdAt: '2026-07-08T00:00:00.000Z',
            updatedAt: '2026-07-08T00:00:00.000Z',
          }),
        ),
    ),
});

describe('sweepTerminalBacklog (F1c — drain the terminal backlog once)', () => {
  it('emits a synthetic item_closed for a live item that reads wg-terminal (no prior close event)', async () => {
    // wg-a folds LIVE (a stage_advance, no close event ever emitted) but its wg status is closed.
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'code', atMs: 1_000 });
    expect(liveItems(await collectLoopState()).map((i) => i.wgId)).toContain('wg-a');

    const emitted = await sweepTerminalBacklog(readerOf([{ id: 'wg-a', status: 'closed' }]), 5_000);
    expect(emitted).toBe(1);

    // after the synthetic close, wg-a folds terminal ⇒ liveItems drops it (the linger is gone).
    const live = liveItems(await collectLoopState());
    expect(live.map((i) => i.wgId)).not.toContain('wg-a');
  });

  it('leaves a live NON-terminal item untouched (only wg-terminal items are drained)', async () => {
    await appendMonitorEvent({
      wgId: 'wg-live',
      kind: 'stage_advance',
      stage: 'plan',
      atMs: 1_000,
    });
    const emitted = await sweepTerminalBacklog(readerOf([]), 5_000);
    expect(emitted).toBe(0);
    expect(liveItems(await collectLoopState()).map((i) => i.wgId)).toContain('wg-live');
  });

  it('does NOT re-close an already-observed close (it folds terminal already → not in the live set)', async () => {
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'stage_advance', stage: 'deploy', atMs: 1_000 });
    await appendMonitorEvent({ wgId: 'wg-a', kind: 'item_closed', atMs: 2_000 });
    // even though wg reports it terminal, it's not in the LIVE set → no duplicate emit.
    const emitted = await sweepTerminalBacklog(readerOf([{ id: 'wg-a', status: 'closed' }]), 5_000);
    expect(emitted).toBe(0);
  });

  it('an empty live board → 0 (nothing folds live → nothing can linger)', async () => {
    expect(await sweepTerminalBacklog(readerOf([{ id: 'wg-x', status: 'archived' }]), 5_000)).toBe(
      0,
    );
  });
});

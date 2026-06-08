/**
 * CMP.4 — compression orchestrator (THIN policy caller) tests. Unit-level with a STUB
 * `consolidateWindow` (retire-Rust RES-4c: the verify+gated-delete D2 contract now lives in the TS
 * `consolidate()`, src/rag/memory/consolidate.ts — its own tests prove the safety internals). These
 * assert the orchestrator POLICY:
 *   D1 (WHEN): only satisfied groups trigger consolidate; not-satisfied → no call at all.
 *   WHAT: each candidate window → one `consolidateWindow(ids)` (deduped).
 *   SURFACE: the outcome (deleted / keptImmune / verified) is reported as-is; `!verified` or a throw
 *     → skipped + drift event. opensquid issues no delete here.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConsolidateOutcome } from '../rag/memory/consolidate.js';

import { runCompression } from './compression_orchestrator.js';
import { readAllDriftCatalogs } from './drift_catalog.js';
import { emitProbe, recordAnswer } from './satisfaction_probe.js';
import { collectCandidates } from './wedge/compress_candidates.js';

const SID = 'cmp4-sess';

interface StubOpts {
  store: Record<string, { consumed_by_user_lessons: number }>;
  mcId?: string;
  /** Force the verify gate to miss (nothing deleted). */
  verified?: boolean;
  /** Reject the consolidate call (error path). */
  fail?: boolean;
}

/** Stub `consolidateWindow` modeling the TS consolidate: non-immune ids → deleted, immune → kept,
 * unless `verified:false` or `fail` overrides. Records the deduped windows it was called with. */
function stubConsolidateWindow(opts: StubOpts): {
  window: (ids: string[]) => Promise<ConsolidateOutcome>;
  calls: string[][];
} {
  const mcId = opts.mcId ?? 'mem-c-deadbeef';
  const verified = opts.verified !== false;
  const calls: string[][] = [];
  const window = (ids: string[]): Promise<ConsolidateOutcome> => {
    calls.push(ids);
    if (opts.fail) return Promise.reject(new Error('consolidate failure'));
    if (!verified) return Promise.resolve({ mcId, deleted: [], keptImmune: [], verified: false });
    const deleted: string[] = [];
    const keptImmune: string[] = [];
    for (const id of ids) {
      if ((opts.store[id]?.consumed_by_user_lessons ?? 0) > 0) keptImmune.push(id);
      else deleted.push(id);
    }
    return Promise.resolve({ mcId, deleted, keptImmune, verified: true });
  };
  return { window, calls };
}

describe('compression_orchestrator (CMP.4 — thin policy caller)', () => {
  let home: string;
  let prior: string | undefined;

  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'cmp4-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  async function satisfy(group: string): Promise<void> {
    await emitProbe(SID, group);
    await recordAnswer(SID, group, true);
  }

  it('1. satisfied + verified + non-immune → predecessors deleted, Mc remains', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { window } = stubConsolidateWindow({
      store: { 'mem-1': { consumed_by_user_lessons: 0 }, 'mem-2': { consumed_by_user_lessons: 0 } },
    });
    const outcomes = await runCompression(SID, 'CMP', window);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.deleted.sort()).toEqual(['mem-1', 'mem-2']);
    expect(outcomes[0]!.skipped).toBe(false);
    expect(outcomes[0]!.mcId).toBe('mem-c-deadbeef');
    expect(outcomes[0]!.keptImmune).toEqual([]);
  });

  it('2. satisfied + verify FAILS → nothing deleted, Mc kept, drift emitted', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { window } = stubConsolidateWindow({
      store: { 'mem-1': { consumed_by_user_lessons: 0 }, 'mem-2': { consumed_by_user_lessons: 0 } },
      verified: false,
    });
    const outcomes = await runCompression(SID, 'CMP', window);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.deleted).toEqual([]);
    expect(outcomes[0]!.mcId).toBe('mem-c-deadbeef');
    const drifts = await readAllDriftCatalogs([], SID);
    expect(drifts.some((d) => d.ruleId === 'compression-recall-replay-gate')).toBe(true);
  });

  it('3. satisfied + a predecessor is user-cited → kept, others deleted', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-cited', 'mem-3'],
      group: 'CMP',
    });
    const { window } = stubConsolidateWindow({
      store: {
        'mem-1': { consumed_by_user_lessons: 0 },
        'mem-cited': { consumed_by_user_lessons: 2 },
        'mem-3': { consumed_by_user_lessons: 0 },
      },
    });
    const outcomes = await runCompression(SID, 'CMP', window);
    expect(outcomes[0]!.keptImmune).toEqual(['mem-cited']);
    expect(outcomes[0]!.deleted.sort()).toEqual(['mem-1', 'mem-3']);
    expect(outcomes[0]!.skipped).toBe(false);
  });

  it('4. NOT satisfied → no consolidate call (orchestrator returns early)', async () => {
    await emitProbe(SID, 'CMP');
    await recordAnswer(SID, 'CMP', false);
    await collectCandidates(SID, { id: 'lesson-1', citedMemoryIds: ['mem-1'], group: 'CMP' });
    const { window, calls } = stubConsolidateWindow({
      store: { 'mem-1': { consumed_by_user_lessons: 0 } },
    });
    const outcomes = await runCompression(SID, 'CMP', window);
    expect(outcomes).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('no answered probe at all → no-op', async () => {
    await collectCandidates(SID, { id: 'l', citedMemoryIds: ['mem-1'], group: 'CMP' });
    const { window, calls } = stubConsolidateWindow({
      store: { 'mem-1': { consumed_by_user_lessons: 0 } },
    });
    expect(await runCompression(SID, 'CMP', window)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('consolidate error → fail-closed (drift emitted, skipped)', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, { id: 'l', citedMemoryIds: ['mem-1', 'mem-2'], group: 'CMP' });
    const { window } = stubConsolidateWindow({
      store: { 'mem-1': { consumed_by_user_lessons: 0 }, 'mem-2': { consumed_by_user_lessons: 0 } },
      fail: true,
    });
    const outcomes = await runCompression(SID, 'CMP', window);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.deleted).toEqual([]);
    const drifts = await readAllDriftCatalogs([], SID);
    expect(drifts.some((d) => d.ruleId === 'compression-recall-replay-gate')).toBe(true);
  });

  it('passes the deduped window ids to consolidateWindow', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'l',
      citedMemoryIds: ['mem-1', 'mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { window, calls } = stubConsolidateWindow({
      store: { 'mem-1': { consumed_by_user_lessons: 0 }, 'mem-2': { consumed_by_user_lessons: 0 } },
    });
    await runCompression(SID, 'CMP', window);
    expect([...calls[0]!].sort()).toEqual(['mem-1', 'mem-2']);
  });
});

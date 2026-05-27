/**
 * CMP.4 (revised) — compression orchestrator (THIN policy caller) tests.
 *
 * Unit-level with a STUB engine (CMP.5 carries the live-engine e2e). The
 * verify+gated-delete contract (D2/D3) now lives INSIDE the engine's
 * `memory.consolidate` op; the orchestrator is a thin policy caller. So
 * these tests assert the POLICY:
 *   D1 (WHEN): only satisfied groups trigger consolidate; not-satisfied
 *     → no consolidate call at all.
 *   WHAT: each candidate window → one `memoryConsolidate({ ids })`.
 *   SURFACE: the engine's outcome (deleted / kept_immune / verified) is
 *     reported as-is; `!verified` → skipped + drift event.
 *
 * The engine's own Rust tests prove the safety internals (recall-replay
 * gate, immunity, fail-closed). opensquid no longer runs recall-replay
 * or issues any memory.delete — these tests verify that absence too.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../engine/client.js';
import type { ConsolidateParams, ConsolidateResult } from '../engine/types.js';

import { runCompression } from './compression_orchestrator.js';
import { readAllDriftCatalogs } from './drift_catalog.js';
import { emitProbe, recordAnswer } from './satisfaction_probe.js';
import { collectCandidates } from './wedge/compress_candidates.js';

const SID = 'cmp4-sess';

/**
 * Stub engine modeling `memory.consolidate`. `store` maps memory id →
 * its immunity counter; the stub computes a verified outcome the way the
 * engine would (non-immune ids → deleted, immune ids → kept_immune),
 * unless `verified: false` or `fail` overrides it.
 */
interface StubOpts {
  store: Record<string, { consumed_by_user_lessons: number }>;
  mcId?: string;
  /** Force the engine's verify gate to miss (nothing deleted). */
  verified?: boolean;
  /** Reject the consolidate RPC (engine error path). */
  fail?: boolean;
}

function stubEngine(opts: StubOpts): {
  engine: EngineClient;
} {
  const mcId = opts.mcId ?? 'mem-c-deadbeef';
  const verified = opts.verified !== false;

  const engine = {
    memoryConsolidate: vi.fn((p: ConsolidateParams): Promise<ConsolidateResult> => {
      if (opts.fail) return Promise.reject(new Error('engine consolidate failure'));
      if (!verified) {
        // Fail-closed: Mc minted but nothing deleted.
        return Promise.resolve({ mc_id: mcId, deleted: [], kept_immune: [], verified: false });
      }
      const deleted: string[] = [];
      const kept_immune: string[] = [];
      for (const id of p.ids) {
        if ((opts.store[id]?.consumed_by_user_lessons ?? 0) > 0) kept_immune.push(id);
        else deleted.push(id);
      }
      return Promise.resolve({ mc_id: mcId, deleted, kept_immune, verified: true });
    }),
  } as unknown as EngineClient;

  return { engine };
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

  it('1. satisfied + engine verified + non-immune → predecessors deleted, Mc remains', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { engine } = stubEngine({
      store: {
        'mem-1': { consumed_by_user_lessons: 0 },
        'mem-2': { consumed_by_user_lessons: 0 },
      },
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.deleted.sort()).toEqual(['mem-1', 'mem-2']);
    expect(outcomes[0]!.skipped).toBe(false);
    expect(outcomes[0]!.mcId).toBe('mem-c-deadbeef');
    expect(outcomes[0]!.keptImmune).toEqual([]);
  });

  it('2. satisfied + engine verify FAILS → nothing deleted, Mc kept, drift emitted', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { engine } = stubEngine({
      store: {
        'mem-1': { consumed_by_user_lessons: 0 },
        'mem-2': { consumed_by_user_lessons: 0 },
      },
      verified: false, // engine gate missed
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.deleted).toEqual([]);
    expect(outcomes[0]!.mcId).toBe('mem-c-deadbeef'); // Mc kept alongside predecessors

    const drifts = await readAllDriftCatalogs([], SID);
    expect(drifts.length).toBeGreaterThanOrEqual(1);
    expect(drifts.some((d) => d.ruleId === 'compression-recall-replay-gate')).toBe(true);
  });

  it('3. satisfied + a predecessor is user-cited → engine keeps it, others deleted', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-cited', 'mem-3'],
      group: 'CMP',
    });
    const { engine } = stubEngine({
      store: {
        'mem-1': { consumed_by_user_lessons: 0 },
        'mem-cited': { consumed_by_user_lessons: 2 }, // user-cited → engine keeps
        'mem-3': { consumed_by_user_lessons: 0 },
      },
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes[0]!.keptImmune).toEqual(['mem-cited']);
    expect(outcomes[0]!.deleted.sort()).toEqual(['mem-1', 'mem-3']);
    expect(outcomes[0]!.skipped).toBe(false);
  });

  it('4. NOT satisfied → no consolidate call (orchestrator returns early)', async () => {
    await emitProbe(SID, 'CMP');
    await recordAnswer(SID, 'CMP', false);
    await collectCandidates(SID, { id: 'lesson-1', citedMemoryIds: ['mem-1'], group: 'CMP' });
    const { engine } = stubEngine({
      store: { 'mem-1': { consumed_by_user_lessons: 0 } },
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes).toEqual([]);
    // The orchestrator never calls consolidate for an unsatisfied group.
    expect((engine.memoryConsolidate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('no answered probe at all → no-op', async () => {
    await collectCandidates(SID, { id: 'l', citedMemoryIds: ['mem-1'], group: 'CMP' });
    const { engine } = stubEngine({ store: { 'mem-1': { consumed_by_user_lessons: 0 } } });
    expect(await runCompression(SID, 'CMP', engine)).toEqual([]);
    expect((engine.memoryConsolidate as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('consolidate RPC error → fail-closed (drift emitted, skipped)', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, { id: 'l', citedMemoryIds: ['mem-1', 'mem-2'], group: 'CMP' });
    const { engine } = stubEngine({
      store: {
        'mem-1': { consumed_by_user_lessons: 0 },
        'mem-2': { consumed_by_user_lessons: 0 },
      },
      fail: true,
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.deleted).toEqual([]);
    const drifts = await readAllDriftCatalogs([], SID);
    expect(drifts.some((d) => d.ruleId === 'compression-recall-replay-gate')).toBe(true);
  });

  it('passes the deduped window ids to the engine consolidate call', async () => {
    await satisfy('CMP');
    // duplicate id in the window → orchestrator dedupes before the call.
    await collectCandidates(SID, {
      id: 'l',
      citedMemoryIds: ['mem-1', 'mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { engine } = stubEngine({
      store: {
        'mem-1': { consumed_by_user_lessons: 0 },
        'mem-2': { consumed_by_user_lessons: 0 },
      },
    });
    await runCompression(SID, 'CMP', engine);
    const call = (engine.memoryConsolidate as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as ConsolidateParams;
    expect([...call.ids].sort()).toEqual(['mem-1', 'mem-2']);
  });
});

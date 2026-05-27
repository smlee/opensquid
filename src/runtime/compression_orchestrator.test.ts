/**
 * CMP.4 — compression orchestrator + recall-replay gate tests.
 *
 * Unit-level with a STUB engine (CMP.5 carries the live-engine e2e). The
 * load-bearing D2 contract: a predecessor is force-deleted ONLY when
 * (a) satisfied + (b) recall-replay passes + (c) not user-cited. Any
 * failure → delete nothing + drift event.
 *
 * The fixtures cover exactly the spec's four cases:
 *   1. satisfied + replay passes + non-immune  → deleted, Mc remains
 *   2. satisfied + replay FAILS                → nothing deleted, drift
 *   3. satisfied + a user-cited predecessor    → that one KEPT, others deleted
 *   4. NOT satisfied                           → no compress, no delete
 * plus: an engine error mid-flow → fail-closed; a user-citation count
 * NEVER bypassed by force.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../engine/client.js';

import { runCompression, recallReplayPasses } from './compression_orchestrator.js';
import { readAllDriftCatalogs } from './drift_catalog.js';
import { emitProbe, recordAnswer } from './satisfaction_probe.js';
import { collectCandidates } from './wedge/compress_candidates.js';

const SID = 'cmp4-sess';

/**
 * Stub engine. `store` maps memory id → its current state. `mcId` is the
 * id the next memoryCompress returns; `recallSurfaces` controls whether
 * recall returns Mc for a predecessor query. `failCompress`/`failOn`
 * inject engine errors.
 */
interface StubOpts {
  store: Record<string, { description: string; consumed_by_user_lessons: number }>;
  mcId?: string;
  recallSurfacesMc?: boolean;
  failCompress?: boolean;
  deleteThrowsOn?: string;
}

function stubEngine(opts: StubOpts): {
  engine: EngineClient;
  deleted: string[];
  compressCalls: number;
} {
  const deleted: string[] = [];
  let compressCalls = 0;
  const mcId = opts.mcId ?? 'mem-c-deadbeef';

  const engine = {
    memoryCompress: vi.fn(({ ids }: { ids: string[] }) => {
      compressCalls += 1;
      if (opts.failCompress) return Promise.reject(new Error('engine compress failure'));
      const sum = ids.reduce((acc, id) => acc + (opts.store[id]?.consumed_by_user_lessons ?? 0), 0);
      return Promise.resolve({
        id: mcId,
        description: 'gist',
        derived_from: ids,
        consumed_by_user_lessons: sum,
      });
    }),
    memorySearch: vi.fn(() =>
      Promise.resolve({
        query: 'q',
        returned: opts.recallSurfacesMc === false ? 0 : 1,
        results: opts.recallSurfacesMc === false ? [] : [{ kind: 'memory', id: mcId } as never],
      }),
    ),
    memoryGet: vi.fn(({ id }: { id: string }) => {
      const row = opts.store[id];
      if (!row) return Promise.reject(new Error(`not found: ${id}`));
      return Promise.resolve({
        id,
        description: row.description,
        content: 'body',
        created_at: 'z',
        scope: 'user' as const,
        consumed_by_user_lessons: row.consumed_by_user_lessons,
        derived_from: [],
      });
    }),
    memoryDelete: vi.fn(({ id }: { id: string; force?: boolean }) => {
      if (opts.deleteThrowsOn === id) return Promise.reject(new Error(`delete failed: ${id}`));
      deleted.push(id);
      return Promise.resolve({ ok: true as const, id, forced: true });
    }),
  } as unknown as EngineClient;

  return { engine, deleted, compressCalls };
}

describe('compression_orchestrator (CMP.4)', () => {
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

  it('1. satisfied + replay passes + non-immune → predecessors deleted, Mc remains', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { engine, deleted } = stubEngine({
      store: {
        'mem-1': { description: 'd1', consumed_by_user_lessons: 0 },
        'mem-2': { description: 'd2', consumed_by_user_lessons: 0 },
      },
      recallSurfacesMc: true,
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.deleted.sort()).toEqual(['mem-1', 'mem-2']);
    expect(outcomes[0]!.skipped).toBe(false);
    expect(outcomes[0]!.mcId).toBe('mem-c-deadbeef');
    expect(deleted.sort()).toEqual(['mem-1', 'mem-2']);
    // Mc itself is never deleted.
    expect(deleted).not.toContain('mem-c-deadbeef');
  });

  it('2. satisfied + recall-replay FAILS → nothing deleted, Mc kept, drift emitted', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-2'],
      group: 'CMP',
    });
    const { engine, deleted } = stubEngine({
      store: {
        'mem-1': { description: 'd1', consumed_by_user_lessons: 0 },
        'mem-2': { description: 'd2', consumed_by_user_lessons: 0 },
      },
      recallSurfacesMc: false, // gate fails
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(outcomes[0]!.deleted).toEqual([]);
    expect(deleted).toEqual([]);

    const drifts = await readAllDriftCatalogs([], SID);
    expect(drifts.length).toBeGreaterThanOrEqual(1);
    expect(drifts.some((d) => d.ruleId === 'compression-recall-replay-gate')).toBe(true);
  });

  it('3. satisfied + a predecessor is user-cited → that one KEPT, others deleted', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-cited', 'mem-3'],
      group: 'CMP',
    });
    const { engine, deleted } = stubEngine({
      store: {
        'mem-1': { description: 'd1', consumed_by_user_lessons: 0 },
        'mem-cited': { description: 'dc', consumed_by_user_lessons: 2 }, // user-cited
        'mem-3': { description: 'd3', consumed_by_user_lessons: 0 },
      },
      recallSurfacesMc: true,
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes[0]!.keptImmune).toEqual(['mem-cited']);
    expect(outcomes[0]!.deleted.sort()).toEqual(['mem-1', 'mem-3']);
    // The user-cited memory is NEVER passed to delete — immunity holds
    // even though force=true would have bypassed the engine guard.
    expect(deleted).not.toContain('mem-cited');
    expect(deleted.sort()).toEqual(['mem-1', 'mem-3']);
  });

  it('4. NOT satisfied → no compress, no delete (orchestrator returns early)', async () => {
    // Probe emitted but answered "false" (or never answered).
    await emitProbe(SID, 'CMP');
    await recordAnswer(SID, 'CMP', false);
    await collectCandidates(SID, { id: 'lesson-1', citedMemoryIds: ['mem-1'], group: 'CMP' });
    const { engine, deleted, compressCalls } = stubEngine({
      store: { 'mem-1': { description: 'd1', consumed_by_user_lessons: 0 } },
      recallSurfacesMc: true,
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes).toEqual([]);
    expect(deleted).toEqual([]);
    expect(compressCalls).toBe(0);
  });

  it('no answered probe at all → no-op', async () => {
    await collectCandidates(SID, { id: 'l', citedMemoryIds: ['mem-1'], group: 'CMP' });
    const { engine, deleted } = stubEngine({
      store: { 'mem-1': { description: 'd1', consumed_by_user_lessons: 0 } },
    });
    expect(await runCompression(SID, 'CMP', engine)).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('engine error mid-flow → fail-closed (drift emitted, no delete past the error)', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, { id: 'l', citedMemoryIds: ['mem-1', 'mem-2'], group: 'CMP' });
    const { engine, deleted } = stubEngine({
      store: {
        'mem-1': { description: 'd1', consumed_by_user_lessons: 0 },
        'mem-2': { description: 'd2', consumed_by_user_lessons: 0 },
      },
      recallSurfacesMc: true,
      deleteThrowsOn: 'mem-1', // first delete throws
    });

    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes[0]!.skipped).toBe(true);
    // The throw happens on mem-1's delete → nothing recorded as deleted,
    // and mem-2 is never reached.
    expect(deleted).toEqual([]);
    const drifts = await readAllDriftCatalogs([], SID);
    expect(drifts.some((d) => d.ruleId === 'compression-recall-replay-gate')).toBe(true);
  });

  it('compress refusal (engine InvalidParams) → fail-closed, nothing deleted', async () => {
    await satisfy('CMP');
    await collectCandidates(SID, { id: 'l', citedMemoryIds: ['mem-1'], group: 'CMP' });
    const { engine, deleted } = stubEngine({
      store: { 'mem-1': { description: 'd1', consumed_by_user_lessons: 0 } },
      failCompress: true,
    });
    const outcomes = await runCompression(SID, 'CMP', engine);
    expect(outcomes[0]!.skipped).toBe(true);
    expect(deleted).toEqual([]);
  });

  describe('recallReplayPasses', () => {
    it('passes when Mc surfaces for every predecessor', async () => {
      const { engine } = stubEngine({
        store: {
          'mem-1': { description: 'd1', consumed_by_user_lessons: 0 },
          'mem-2': { description: 'd2', consumed_by_user_lessons: 0 },
        },
        recallSurfacesMc: true,
      });
      expect(await recallReplayPasses(engine, ['mem-1', 'mem-2'], 'mem-c-deadbeef')).toBe(true);
    });

    it('fails when Mc is missing for a predecessor', async () => {
      const { engine } = stubEngine({
        store: { 'mem-1': { description: 'd1', consumed_by_user_lessons: 0 } },
        recallSurfacesMc: false,
      });
      expect(await recallReplayPasses(engine, ['mem-1'], 'mem-c-deadbeef')).toBe(false);
    });

    it('fails closed when a predecessor has no usable query', async () => {
      const { engine } = stubEngine({
        store: { 'mem-1': { description: '   ', consumed_by_user_lessons: 0 } },
        recallSurfacesMc: true,
      });
      expect(await recallReplayPasses(engine, ['mem-1'], 'mem-c-deadbeef')).toBe(false);
    });
  });
});

/**
 * Tests for consolidate() (retire-Rust RES-4b): the D2 verified, immunity-gated, fail-closed
 * compaction. Stub deps — no real DB/LLM. The minted Mc id is captured from insertMemory so
 * recallIds can simulate Mc's presence/absence in the top-k.
 */
import { describe, expect, it } from 'vitest';

import { CompressionScopeMismatchError, type MemoryRow } from './compress.js';
import { consolidate, type ConsolidateDeps } from './consolidate.js';

function mem(over: Partial<MemoryRow> & { id: string }): MemoryRow {
  return {
    content: `content of ${over.id}`,
    tags: ['scope:user'],
    source: 'memory',
    author: 'agent',
    createdAt: '2026-06-01T00:00:00.000Z',
    derivedFrom: [],
    consumedByUserLessons: 0,
    ...over,
  };
}

const okDraft = JSON.stringify({ description: 'a summary', content: 'the gist body' });

interface Opts {
  recallReturnsMc?: boolean;
  recallThrows?: boolean;
  deleteThrowsFor?: string;
  getMemoryByIdOverride?: (id: string, call: number) => MemoryRow | null;
}

function makeDeps(rows: MemoryRow[], opts: Opts = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const captured = { inserted: [] as MemoryRow[], deleted: [] as string[] };
  const calls = new Map<string, number>();
  const deps: ConsolidateDeps = {
    getMemoryById: (id) => {
      const n = (calls.get(id) ?? 0) + 1;
      calls.set(id, n);
      if (opts.getMemoryByIdOverride) return Promise.resolve(opts.getMemoryByIdOverride(id, n));
      return Promise.resolve(byId.get(id) ?? null);
    },
    insertMemory: (m) => {
      captured.inserted.push(m);
      byId.set(m.id, m);
      return Promise.resolve();
    },
    summarize: () => Promise.resolve(okDraft),
    embed: () => Promise.resolve([0.1, 0.2]),
    now: () => new Date('2026-06-08T00:00:00.000Z'),
    recallIds: (_q, _k) => {
      if (opts.recallThrows) return Promise.reject(new Error('search down'));
      const mcId = captured.inserted[0]?.id;
      const base = ['m-a', 'm-b'];
      return Promise.resolve(opts.recallReturnsMc !== false && mcId ? [mcId, ...base] : base);
    },
    demoteMemory: (id: string) => {
      if (opts.deleteThrowsFor === id) return Promise.reject(new Error('demote failed'));
      captured.deleted.push(id);
      byId.delete(id);
      return Promise.resolve();
    },
  };
  return { deps, captured };
}

describe('consolidate', () => {
  it('happy path: verifies, then deletes the non-immune predecessors', async () => {
    const { deps, captured } = makeDeps([mem({ id: 'm-a' }), mem({ id: 'm-b' })]);
    const out = await consolidate(deps, ['m-a', 'm-b']);
    expect(out.verified).toBe(true);
    expect(out.deleted.sort()).toEqual(['m-a', 'm-b']);
    expect(out.keptImmune).toEqual([]);
    expect(out.mcId).toMatch(/^mem-c-/);
    expect(captured.inserted).toHaveLength(1); // Mc minted
  });

  it('verify-miss: deletes NOTHING (fail-closed) when Mc is absent from the hits', async () => {
    const { deps, captured } = makeDeps([mem({ id: 'm-a' }), mem({ id: 'm-b' })], {
      recallReturnsMc: false,
    });
    const out = await consolidate(deps, ['m-a', 'm-b']);
    expect(out.verified).toBe(false);
    expect(out.deleted).toEqual([]);
    expect(captured.deleted).toEqual([]); // deleteMemory never called
  });

  it('search error during verify → fail-closed (nothing deleted)', async () => {
    const { deps, captured } = makeDeps([mem({ id: 'm-a' })], { recallThrows: true });
    const out = await consolidate(deps, ['m-a']);
    expect(out.verified).toBe(false);
    expect(captured.deleted).toEqual([]);
  });

  it('recallK=0 → fail-closed (nothing deleted), Mc still minted', async () => {
    const { deps, captured } = makeDeps([mem({ id: 'm-a' })]);
    const out = await consolidate(deps, ['m-a'], 0);
    expect(out.verified).toBe(false);
    expect(out.deleted).toEqual([]);
    expect(captured.inserted).toHaveLength(1);
  });

  it('keeps an immune predecessor (consumed_by_user_lessons > 0), deletes the rest', async () => {
    const { deps, captured } = makeDeps([
      mem({ id: 'm-a', consumedByUserLessons: 2 }), // immune
      mem({ id: 'm-b', consumedByUserLessons: 0 }),
    ]);
    const out = await consolidate(deps, ['m-a', 'm-b']);
    expect(out.verified).toBe(true);
    expect(out.keptImmune).toContain('m-a');
    expect(out.deleted).toEqual(['m-b']);
    expect(captured.deleted).toEqual(['m-b']); // immune never force-deleted
  });

  it('re-loads the authoritative counter before delete (0 at verify, >0 at delete → kept)', async () => {
    // getMemoryById returns consumed 0 on the verify-phase calls but >0 on the delete-phase re-load.
    const { deps } = makeDeps([mem({ id: 'm-a' })], {
      getMemoryByIdOverride: (id, call) => mem({ id, consumedByUserLessons: call >= 2 ? 9 : 0 }), // 1st call (verify) = 0; 2nd (delete) = 9
    });
    const out = await consolidate(deps, ['m-a']);
    expect(out.verified).toBe(true);
    expect(out.keptImmune).toEqual(['m-a']); // the re-loaded counter wins
    expect(out.deleted).toEqual([]);
  });

  it('a delete error is non-fatal: that predecessor is kept, others still deleted', async () => {
    const { deps } = makeDeps([mem({ id: 'm-a' }), mem({ id: 'm-b' })], { deleteThrowsFor: 'm-a' });
    const out = await consolidate(deps, ['m-a', 'm-b']);
    expect(out.verified).toBe(true);
    expect(out.keptImmune).toContain('m-a');
    expect(out.deleted).toEqual(['m-b']);
  });

  it('RSW.1: keeps a user-authored predecessor (never demotes user memory), deletes the rest', async () => {
    const { deps, captured } = makeDeps([
      mem({ id: 'm-a', author: 'user', consumedByUserLessons: 0 }), // user → immune even uncited
      mem({ id: 'm-b', author: 'agent', consumedByUserLessons: 0 }),
    ]);
    const out = await consolidate(deps, ['m-a', 'm-b']);
    expect(out.verified).toBe(true);
    expect(out.keptImmune).toContain('m-a');
    expect(out.deleted).toEqual(['m-b']);
    expect(captured.deleted).toEqual(['m-b']); // the user memory is never demoted
  });

  it('a compress error propagates and deletes nothing', async () => {
    const { deps, captured } = makeDeps([
      mem({ id: 'm-a', tags: ['scope:user'] }),
      mem({ id: 'm-b', tags: ['scope:team'] }), // scope mismatch → compress throws
    ]);
    await expect(consolidate(deps, ['m-a', 'm-b'])).rejects.toBeInstanceOf(
      CompressionScopeMismatchError,
    );
    expect(captured.deleted).toEqual([]);
  });
});

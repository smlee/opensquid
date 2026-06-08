/**
 * Tests for the pure memory compression port (retire-Rust RES-4a): cycle.ts (current-path DFS) +
 * compress.ts (gist-mint with stub deps — no real DB/LLM).
 */
import { describe, expect, it } from 'vitest';

import {
  COMPRESSION_MAX_CHAIN_DEPTH,
  CompressionCycleError,
  detectCycleInWindow,
} from './cycle.js';
import {
  compress,
  CompressionInsufficientInputError,
  CompressionParseError,
  CompressionScopeMismatchError,
  CompressionValidationError,
  type CompressDeps,
  type MemoryRow,
} from './compress.js';

// ---------------------------------------------------------------------------
// cycle.ts
// ---------------------------------------------------------------------------

describe('detectCycleInWindow', () => {
  const chain =
    (g: Record<string, string[]>) =>
    (id: string): Promise<string[] | null> =>
      Promise.resolve(g[id] ?? null);

  it('passes a diamond DAG (same ancestor via two branches is NOT a cycle)', async () => {
    // d → b → a ; d → c → a   (a reachable two ways, but no cycle)
    await expect(
      detectCycleInWindow(chain({ d: ['b', 'c'], b: ['a'], c: ['a'], a: [] }), ['d']),
    ).resolves.toBeUndefined();
  });

  it('throws on a true back-edge cycle', async () => {
    await expect(
      detectCycleInWindow(chain({ a: ['b'], b: ['c'], c: ['a'] }), ['a']),
    ).rejects.toBeInstanceOf(CompressionCycleError);
  });

  it('throws when the chain exceeds the depth cap', async () => {
    const g: Record<string, string[]> = {};
    for (let i = 0; i < COMPRESSION_MAX_CHAIN_DEPTH + 3; i++) g[`m${i}`] = [`m${i + 1}`];
    g[`m${COMPRESSION_MAX_CHAIN_DEPTH + 3}`] = [];
    await expect(detectCycleInWindow(chain(g), ['m0'])).rejects.toBeInstanceOf(
      CompressionCycleError,
    );
  });

  it('skips absent predecessors (null) without error', async () => {
    await expect(detectCycleInWindow(chain({ a: ['ghost'] }), ['a'])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// compress.ts
// ---------------------------------------------------------------------------

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

function deps(
  rows: MemoryRow[],
  summarizeOut: string,
  captured?: { inserted: MemoryRow[] },
): CompressDeps {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    getMemoryById: (id) => Promise.resolve(byId.get(id) ?? null),
    insertMemory: (m) => {
      captured?.inserted.push(m);
      return Promise.resolve();
    },
    summarize: () => Promise.resolve(summarizeOut),
    embed: () => Promise.resolve([0.1, 0.2, 0.3]),
    now: () => new Date('2026-06-08T00:00:00.000Z'),
  };
}

const okDraft = JSON.stringify({ description: 'a compressed summary', content: 'the gist body' });

describe('compress', () => {
  it('mints Mc with derivedFrom + saturating summed counter; predecessors untouched', async () => {
    const a = mem({ id: 'm-a', consumedByUserLessons: 3 });
    const b = mem({ id: 'm-b', consumedByUserLessons: 5 });
    const snapshotA = JSON.stringify(a);
    const captured = { inserted: [] as MemoryRow[] };
    const mc = await compress(deps([a, b], okDraft, captured), ['m-a', 'm-b']);
    expect(mc.id).toMatch(/^mem-c-[0-9a-f]{16}$/);
    expect(mc.derivedFrom).toEqual(['m-a', 'm-b']);
    expect(mc.consumedByUserLessons).toBe(8);
    expect(mc.tags).toEqual(['scope:user']);
    expect(mc.content).toContain('the gist body');
    expect(captured.inserted).toHaveLength(1); // ONLY Mc inserted — no predecessor delete
    expect(JSON.stringify(a)).toBe(snapshotA); // predecessor byte-unchanged
  });

  it('dedupes the window before counting (no double-count)', async () => {
    const a = mem({ id: 'm-a', consumedByUserLessons: 4 });
    const mc = await compress(deps([a], okDraft), ['m-a', 'm-a']);
    expect(mc.derivedFrom).toEqual(['m-a']);
    expect(mc.consumedByUserLessons).toBe(4);
  });

  it('saturates the counter at u32 max', async () => {
    const a = mem({ id: 'm-a', consumedByUserLessons: 0xffffffff });
    const b = mem({ id: 'm-b', consumedByUserLessons: 10 });
    const mc = await compress(deps([a, b], okDraft), ['m-a', 'm-b']);
    expect(mc.consumedByUserLessons).toBe(0xffffffff);
  });

  it('throws on an empty window', async () => {
    await expect(compress(deps([], okDraft), [])).rejects.toBeInstanceOf(
      CompressionInsufficientInputError,
    );
  });

  it('throws on a scope mismatch across the window (scope: tag)', async () => {
    const a = mem({ id: 'm-a', tags: ['scope:user'] });
    const b = mem({ id: 'm-b', tags: ['scope:team'] });
    await expect(compress(deps([a, b], okDraft), ['m-a', 'm-b'])).rejects.toBeInstanceOf(
      CompressionScopeMismatchError,
    );
  });

  it('maps an LLM `error` key (refusal) to InsufficientInput', async () => {
    const a = mem({ id: 'm-a' });
    await expect(
      compress(deps([a], JSON.stringify({ error: 'insufficient_input' })), ['m-a']),
    ).rejects.toBeInstanceOf(CompressionInsufficientInputError);
  });

  it('throws CompressionParseError on non-JSON LLM output', async () => {
    const a = mem({ id: 'm-a' });
    await expect(compress(deps([a], 'not json at all'), ['m-a'])).rejects.toBeInstanceOf(
      CompressionParseError,
    );
  });

  it('throws CompressionValidationError on empty content', async () => {
    const a = mem({ id: 'm-a' });
    const bad = JSON.stringify({ description: 'desc', content: '   ' });
    await expect(compress(deps([a], bad), ['m-a'])).rejects.toBeInstanceOf(
      CompressionValidationError,
    );
  });

  it('throws when a predecessor is missing', async () => {
    await expect(compress(deps([], okDraft), ['ghost'])).rejects.toThrow(/not found/);
  });
});

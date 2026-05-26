/**
 * LRU parse cache tests — Task H.1.5.
 *
 * Acceptance contract (spec H.1.5):
 *   - ≥10 cases covering hit / miss / eviction at the 257th entry / stats /
 *     clear / boundary conditions.
 *   - `cache.size` is the lru-cache v11 property surface (not a method).
 *
 * Module-state isolation note: `cache.ts` instantiates a single LRU at
 * module load (per-process singleton). Vitest's default per-test-file
 * module isolation gives us a fresh cache per file, but WITHIN this file
 * the cache persists across `it()` blocks — so every test starts with
 * `clear()` to make state explicit and the eviction-counting tests
 * deterministic.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ASTNode } from './ast.js';
import { clear, getCached, MAX_ENTRIES, setCached, stats } from './cache.js';

// Minimal AST helper — the cache stores ASTNode opaquely and never inspects
// shape, so a literal with a varying value is sufficient for identity tests.
const ast = (value: number): ASTNode => ({ kind: 'literal', value, offset: 0 });

beforeEach(() => {
  clear();
});

describe('cache — basic get/set', () => {
  it('returns undefined on miss', () => {
    expect(getCached('never-set')).toBeUndefined();
  });

  it('returns the stored AST on hit', () => {
    const node = ast(42);
    setCached('a', node);
    expect(getCached('a')).toBe(node); // reference identity preserved
  });

  it('overwrites on set with the same key', () => {
    const first = ast(1);
    const second = ast(2);
    setCached('k', first);
    setCached('k', second);
    expect(getCached('k')).toBe(second);
  });

  it('treats distinct keys independently', () => {
    const a = ast(1);
    const b = ast(2);
    setCached('a', a);
    setCached('b', b);
    expect(getCached('a')).toBe(a);
    expect(getCached('b')).toBe(b);
  });
});

describe('cache — stats', () => {
  it('reports size 0 + max MAX_ENTRIES when empty', () => {
    expect(stats()).toEqual({ size: 0, max: MAX_ENTRIES });
  });

  it('reports size 1 after a single set', () => {
    setCached('a', ast(1));
    expect(stats().size).toBe(1);
    expect(stats().max).toBe(MAX_ENTRIES);
  });

  it('reports max = 256 (locked sizing per pre-research §6.1)', () => {
    expect(MAX_ENTRIES).toBe(256);
    expect(stats().max).toBe(256);
  });
});

describe('cache — clear', () => {
  it('drops all entries and resets size to 0', () => {
    setCached('a', ast(1));
    setCached('b', ast(2));
    expect(stats().size).toBe(2);
    clear();
    expect(stats().size).toBe(0);
    expect(getCached('a')).toBeUndefined();
    expect(getCached('b')).toBeUndefined();
  });

  it('is idempotent (clear on empty stays empty)', () => {
    clear();
    expect(stats().size).toBe(0);
  });
});

describe('cache — LRU eviction at the 257th entry', () => {
  it('caps at MAX_ENTRIES and evicts the least-recently-used entry', () => {
    // Fill to exactly the cap.
    for (let i = 0; i < MAX_ENTRIES; i++) {
      setCached(`k${i}`, ast(i));
    }
    expect(stats().size).toBe(MAX_ENTRIES);
    // k0 is the oldest (least-recently-used).
    expect(getCached('k0')).toBeDefined();

    // Re-touch k0 so it becomes the most-recently-used; k1 is now LRU.
    // Note: lru-cache v11's `get()` updates recency by default.
    getCached('k0');

    // Insert the 257th entry. lru-cache v11 maintains the cap by evicting
    // the LRU entry on overflow — k1, not k0, should disappear.
    setCached('k257', ast(257));
    expect(stats().size).toBe(MAX_ENTRIES);
    expect(getCached('k1')).toBeUndefined(); // evicted
    expect(getCached('k0')).toBeDefined(); // preserved by the get() touch
    expect(getCached('k257')).toBeDefined(); // freshly inserted
  });

  it('total size never exceeds MAX_ENTRIES even under heavy churn', () => {
    for (let i = 0; i < MAX_ENTRIES * 3; i++) {
      setCached(`churn${i}`, ast(i));
    }
    expect(stats().size).toBe(MAX_ENTRIES);
  });
});

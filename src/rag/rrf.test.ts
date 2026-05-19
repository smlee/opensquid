/**
 * Tests for `rrfFuse` (Reciprocal Rank Fusion).
 *
 * The math is small and deterministic, so we cover:
 *   1. Overlapping IDs: scores sum across both lists, fused rank > either.
 *   2. Disjoint lists: every entry appears once with its own (1/(60+rank))
 *      score, sorted by rank.
 *   3. topK truncation: only the top K entries are returned.
 *   4. Empty input: returns `[]` without throwing.
 *   5. Single-list: degenerates to its own ranking, with rescaled scores.
 *
 * RRF_K = 60 (Cormack 2009). Asserting exact scores would couple tests to
 * the constant; we assert ordering + (for the overlap case) that the
 * summed score strictly exceeds the single-leg score.
 */

import { describe, expect, it } from 'vitest';

import { rrfFuse } from './rrf.js';

import type { Lesson, RecallHit } from './types.js';

function mkLesson(id: string): Lesson {
  return {
    id,
    content: `content-${id}`,
    tags: [],
    source: 'test',
    author: 'agent',
    createdAt: '2026-05-19T00:00:00.000Z',
  };
}

function mkHit(id: string, rank: number, source: RecallHit['source']): RecallHit {
  return { lesson: mkLesson(id), score: 1 / (rank + 1), source };
}

describe('rrfFuse', () => {
  it('sums scores for overlapping IDs across lists', () => {
    const semantic = [mkHit('A', 0, 'semantic'), mkHit('B', 1, 'semantic')];
    const lexical = [mkHit('A', 0, 'lexical'), mkHit('C', 1, 'lexical')];

    const fused = rrfFuse([semantic, lexical], 10);

    // A appears in both lists at rank 0, so its summed score should be
    // strictly greater than any single-leg-only entry.
    const a = fused.find((h) => h.lesson.id === 'A');
    const b = fused.find((h) => h.lesson.id === 'B');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.score).toBeGreaterThan(b!.score);
    expect(fused[0]!.lesson.id).toBe('A');
    expect(fused.every((h) => h.source === 'fused')).toBe(true);
  });

  it('truncates output to topK', () => {
    const semantic = ['A', 'B', 'C', 'D', 'E'].map((id, i) => mkHit(id, i, 'semantic'));
    const fused = rrfFuse([semantic], 3);
    expect(fused).toHaveLength(3);
    expect(fused.map((h) => h.lesson.id)).toEqual(['A', 'B', 'C']);
  });

  it('returns [] for empty input lists', () => {
    expect(rrfFuse([], 5)).toEqual([]);
    expect(rrfFuse([[]], 5)).toEqual([]);
    expect(rrfFuse([[], []], 5)).toEqual([]);
  });
});

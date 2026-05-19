/**
 * Reciprocal Rank Fusion (Cormack et al., SIGIR 2009 §3).
 *
 * Combines multiple ranked lists into a single fused list with the formula
 * `score(id) = Σ 1 / (k + rank_i(id))` where `k = 60` is the constant from
 * the original paper. The hybrid backend uses RRF to merge the semantic
 * (vector-cosine) and lexical (FTS5) rankings — neither ordering alone
 * matches user intent for short-form lesson recall.
 *
 * Why `RRF_K = 60`: large enough to dampen top-rank dominance (the
 * 1-vs-2 gap is ~1.6 % rather than 50 %), small enough that rank still
 * matters past position 10. Don't tune this without a benchmark — every
 * dataset re-derives back to ~60.
 *
 * Imports from: ./types.js.
 * Imported by: src/rag/backends/libsql_qwen3.ts.
 */

import type { RecallHit } from './types.js';

const RRF_K = 60;

export function rrfFuse(lists: RecallHit[][], topK: number): RecallHit[] {
  const scores = new Map<string, { lesson: RecallHit['lesson']; score: number }>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const id = hit.lesson.id;
      const inc = 1 / (RRF_K + i + 1);
      const prev = scores.get(id);
      if (prev) prev.score += inc;
      else scores.set(id, { lesson: hit.lesson, score: inc });
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK)
    .map(([, v]) => ({ lesson: v.lesson, score: v.score, source: 'fused' as const }));
}

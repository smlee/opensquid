/**
 * Phase 4: recall ranking utilities — Reciprocal Rank Fusion (RRF)
 * + similarity-threshold gating.
 *
 * The engine returns lessons (text-match similarity) and memories
 * (semantic-vector similarity) on different score scales — they're
 * not directly comparable. RRF sidesteps that: it ignores absolute
 * scores and uses ranks-within-list only. Items appearing in BOTH
 * lists get a strong combined boost — "the text matched AND the
 * embedding is close" is the most reliable signal.
 *
 * The similarity threshold filters PER-SOURCE before merging so a
 * weak hit in one list can't poison the merged ranking. When all
 * results are filtered out, recall returns an empty merged array —
 * "no relevant context" is decision-makable; "top hit at sim=0.31"
 * is noise.
 */

/** Conventional RRF damping constant — survives well across domains. */
export const RRF_K = 60;

/** Default minimum similarity to consider a result relevant. */
export const DEFAULT_MIN_SIMILARITY = 0.5;

export interface LessonHit {
  kind: "lesson";
  id: string;
  description: string;
  status: string;
  body_preview: string;
  similarity: number;
  applied_count: number;
}

export interface MemoryHit {
  kind: "memory";
  id: string;
  description: string;
  body_preview: string;
  similarity: number;
}

export type RecallHit = LessonHit | MemoryHit;

export interface MergedHit {
  kind: "lesson" | "memory";
  id: string;
  description: string;
  body_preview: string;
  /** Original per-source similarity (lesson text-match or memory semantic). */
  similarity: number;
  /** RRF score — higher is better. Not directly comparable to similarity. */
  rrf_score: number;
  /** 1-based rank in the lesson list (undefined if not a lesson hit). */
  lesson_rank?: number;
  /** 1-based rank in the memory list (undefined if not a memory hit). */
  memory_rank?: number;
}

/**
 * Filter a hit list to those with similarity at or above `threshold`.
 * Stable: preserves the input order (which is engine-side rank).
 */
export function filterBySimilarity<T extends { similarity: number }>(
  hits: T[],
  threshold: number,
): T[] {
  if (threshold <= 0) return hits;
  return hits.filter((h) => h.similarity >= threshold);
}

/**
 * Reciprocal Rank Fusion across two ranked lists. The RRF score for
 * an item is `sum over each source list: 1 / (RRF_K + rank_in_that_list)`,
 * where rank is 1-based. Items appearing in both lists accumulate
 * contributions and naturally rank above single-source items.
 *
 * Returns merged hits ordered by descending `rrf_score`. Identity is
 * by `id` — a lesson and a memory with the same id (engine never
 * collides these in practice) would merge; we treat that as harmless.
 */
export function mergeRrf(lessons: LessonHit[], memories: MemoryHit[]): MergedHit[] {
  const byId = new Map<string, MergedHit>();

  lessons.forEach((h, idx) => {
    const rank = idx + 1; // 1-based
    const score = 1 / (RRF_K + rank);
    byId.set(h.id, {
      kind: "lesson",
      id: h.id,
      description: h.description,
      body_preview: h.body_preview,
      similarity: h.similarity,
      rrf_score: score,
      lesson_rank: rank,
    });
  });

  memories.forEach((h, idx) => {
    const rank = idx + 1;
    const score = 1 / (RRF_K + rank);
    const existing = byId.get(h.id);
    if (existing) {
      existing.rrf_score += score;
      existing.memory_rank = rank;
    } else {
      byId.set(h.id, {
        kind: "memory",
        id: h.id,
        description: h.description,
        body_preview: h.body_preview,
        similarity: h.similarity,
        rrf_score: score,
        memory_rank: rank,
      });
    }
  });

  return Array.from(byId.values()).sort((a, b) => b.rrf_score - a.rrf_score);
}

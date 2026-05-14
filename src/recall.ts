/**
 * Simple text-match recall for v0.1.
 *
 * Scoring is naive (case-insensitive word overlap + substring boost)
 * — good enough to surface useful lessons without taking on an
 * embedder dependency. Real vector search lands when loop-engine
 * integrates.
 */

import type { Lesson, LessonRef } from "./types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in",
  "on", "for", "with", "as", "by", "at", "is", "are", "was", "were",
  "be", "been", "being", "i", "you", "we", "they", "it", "this", "that",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function score(query: string, lesson: Lesson): number {
  const qTokens = new Set(tokens(query));
  if (qTokens.size === 0) return 0;
  const haystack = `${lesson.description} ${lesson.body}`;
  const hTokens = new Set(tokens(haystack));
  let overlap = 0;
  for (const t of qTokens) {
    if (hTokens.has(t)) overlap += 1;
  }
  const tokenScore = overlap / qTokens.size;
  // substring bonus: catches multi-word phrase matches the token
  // model misses
  const substringBonus = haystack.toLowerCase().includes(query.toLowerCase()) ? 0.3 : 0;
  return Math.min(1, tokenScore + substringBonus);
}

function preview(body: string, max = 240): string {
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trimEnd() + "…";
}

export function recall(query: string, lessons: Lesson[], limit = 5): LessonRef[] {
  // Drop discarded by default; if you want them, set status:"discarded"
  // filter externally (v0.2).
  const candidates = lessons.filter((l) => l.status !== "discarded");
  const scored = candidates
    .map((l) => ({ lesson: l, sim: score(query, l) }))
    .filter((s) => s.sim > 0)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
  return scored.map(({ lesson, sim }) => ({
    id: lesson.id,
    description: lesson.description,
    status: lesson.status,
    bodyPreview: preview(lesson.body),
    similarity: Number(sim.toFixed(3)),
  }));
}

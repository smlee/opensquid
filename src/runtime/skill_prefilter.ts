/**
 * Embedder pre-filter for skill candidate selection (Phase 3 Task 3.3).
 *
 * Purpose: given a task subject string and a flat list of skills, rank
 * skills by cosine similarity between the subject embedding and each
 * skill's prose embedding, then return the top-K. The router (Task 3.4)
 * consumes this shortlist — the LLM classifier sees ~10 skills instead
 * of every skill in every pack, which keeps the prompt tractable and
 * the per-task token cost bounded.
 *
 * Two-tier design (per `project_opensquid_reduced_context_first_principle`
 * — "less in context = less drift"): the embedder is the cheap filter,
 * the model-aliased classifier is the expensive sort. Top-K of cosine
 * recall is sufficient because the classifier handles precision; we
 * deliberately bias toward recall here.
 *
 * Failure mode is "fall through to load-everything" — if Ollama is
 * unreachable, returning every skill is the correct behavior. The
 * router then re-filters via `fast_classifier`, or, in the worst
 * case (both unavailable), the runtime loads every skill, which is
 * the same condition you'd be in WITHOUT this layer. That's the
 * design ladder: each layer is an optional optimization, not a gate.
 *
 * Cache contract: callers supply a `Map<string, number[]>` keyed by
 * the prose string used to embed. The cache is content-addressed —
 * if a skill's prose changes, the new key won't hit, the new vector
 * gets stored, and the stale entry harmlessly stays in the map until
 * the caller decides to evict it. Phase 3 leaves invalidation to
 * consumers per the risk callout.
 *
 * Imports from: ../rag/ollama_client.js (the shared Ollama embed
 *   client used by the libsql RAG backend — single dependency point
 *   on the embedder), ./types.js (Skill type).
 * Imported by: src/runtime/index.ts (re-exported as `prefilterSkills`)
 *   and the dispatcher pipeline once Phase 3 wiring lands.
 */

import { ollamaEmbed } from '../rag/ollama_client.js';

import type { Skill } from './types.js';

// ---------------------------------------------------------------------------
// PrefilterOptions — caller-controlled knobs.
//
//   k         — top-K cap; defaults to 10 per design doc Phase 3 entry.
//   ollamaUrl — embedder endpoint; defaults to the standard local Ollama
//               port (`http://localhost:11434`).
//   cache     — per-prose vector cache. Externalized so the caller can
//               persist across task ticks (Map ref kept stable in the
//               dispatcher's session state).
// ---------------------------------------------------------------------------

export interface PrefilterOptions {
  k?: number;
  ollamaUrl?: string;
  cache?: Map<string, number[]>;
}

/**
 * Rank skills by embedding similarity to `taskSubject`; return top-K.
 *
 * Behavior:
 *  - Empty `skills`        → `[]` (cheap short-circuit).
 *  - Ollama unreachable on subject embedding → return ALL skills (fallback).
 *  - Ollama unreachable on a skill's embedding → skip that skill (still
 *    rank the rest). This is intentional asymmetry: a one-off skill
 *    fetch failure shouldn't blow up the whole rank, but if the very
 *    first call fails the embedder is presumed dead.
 *  - `k > skills.length`   → all (post-rank) skills.
 *
 * Cosine is computed inline (no extra dep). The formula's denominator
 * guards against zero-norm vectors by `|| 1` — that turns a degenerate
 * "embedded the empty string" case into a 0 score rather than NaN.
 */
export async function prefilterSkills(
  taskSubject: string,
  skills: Skill[],
  opts: PrefilterOptions = {},
): Promise<Skill[]> {
  if (skills.length === 0) return [];

  const k = opts.k ?? 10;
  const cache = opts.cache ?? new Map<string, number[]>();
  const ollamaUrl = opts.ollamaUrl ?? 'http://localhost:11434';

  let subjectVec: number[];
  try {
    subjectVec = await ollamaEmbed(ollamaUrl, taskSubject);
  } catch {
    // Embedder dead — degrade to "load everything" and let the router
    // (or the dispatcher) handle filtering downstream.
    return skills;
  }

  const scored: { skill: Skill; score: number }[] = [];
  for (const s of skills) {
    // `prose` is optional on Skill; fall back to `name` so we always
    // have something to embed. Skill name is a weak signal — the risk
    // callout in the task spec notes this; production packs should
    // author prose.
    const desc = s.prose ?? s.name;
    let vec = cache.get(desc);
    if (!vec) {
      try {
        vec = await ollamaEmbed(ollamaUrl, desc);
        cache.set(desc, vec);
      } catch {
        // Skip this skill; continue ranking the rest. A flaky per-skill
        // failure shouldn't wipe the whole shortlist.
        continue;
      }
    }
    scored.push({ skill: s, score: cosine(subjectVec, vec) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => x.skill);
}

/**
 * Cosine similarity between two equal-length numeric vectors.
 *
 * No extra dep — implemented inline per acceptance criterion. Vectors
 * are assumed to be the same dimension (Qwen3 2560 in production); a
 * length mismatch would silently truncate to `a.length`. That's the
 * embedder's contract responsibility, not this function's: every
 * `ollamaEmbed` call against the same model returns the same dim.
 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  // `|| 1` short-circuits the zero-norm degenerate case to 0 (via dot=0
  // when one of the vectors is all-zeros) rather than NaN.
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

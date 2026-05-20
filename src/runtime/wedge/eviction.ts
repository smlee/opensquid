/**
 * User-authored lesson eviction immunity (Task 7.5).
 *
 * Authoritative source: `feedback_user_authored_lessons_immune` (memory) +
 * `docs/opensquid-real-design.md` §"Strategic moat".
 *
 * The runtime MUST NOT auto-evict, supersede, discard, or
 * compress-away lessons authored by the user OR memories that those lessons
 * cite. Only the user can reverse their own authorship. This is a stronger
 * signal than the wedge gate itself — even a clean Stage 2 promotion that
 * would replace a user-authored lesson is refused.
 *
 * `decideEviction` is the only public surface; every eviction code path in
 * `src/runtime/wedge/` MUST funnel through it. The audit grep for this
 * module — `rg "evict|supersede" src/runtime/wedge/ | grep -v eviction.ts` —
 * surfaces every call site so we can confirm each consults `decideEviction`
 * (or has a documented reason not to, like the spec phrase in promote.ts).
 *
 * Three input shapes, three outputs:
 *
 *   user-authored   → refuse + reason "user-authored eviction-immune".
 *   agent-authored  → evict + reason "agent-authored, eligible".
 *   missing author  → REFUSE (default-safe). Per the spec's risk callout,
 *                     the absence of an `author` field is treated as
 *                     "potentially user" rather than "definitely agent" —
 *                     because the cost of accidentally evicting user content
 *                     is irreversible, while the cost of preserving an
 *                     agent lesson is a stale cache entry.
 *
 * Imports from: ../../rag/types (type only).
 * Imported by: src/runtime/wedge/index.ts, Phase 8 eviction pipeline.
 */

import type { Lesson } from '../../rag/types.js';

// ---------------------------------------------------------------------------
// EvictionDecision — single-discriminant return shape.
//
// `decision` is the verdict; `reason` is human-readable text for the
// notification primitive (Task 5.x) to surface to the user when an eviction
// is refused. Even on `evict`, the reason field is populated — the caller
// may want to log "evicting <id> because: agent-authored, eligible" for
// audit purposes.
// ---------------------------------------------------------------------------

export interface EvictionDecision {
  decision: 'evict' | 'refuse';
  reason: string;
}

// ---------------------------------------------------------------------------
// decideEviction — pure decision function.
//
// Pure: no I/O, no clock, no random. The caller is responsible for actually
// performing (or not performing) the eviction after consulting this function.
// ---------------------------------------------------------------------------

export function decideEviction(lesson: Lesson | { author?: string }): EvictionDecision {
  // Defensive: read `author` off the lesson without assuming the runtime
  // type. Untyped JSON from the RAG backend could carry a missing or wrong-
  // typed field; default-refuse handles both safely.
  const author = (lesson as { author?: unknown }).author;

  if (author === 'user') {
    return {
      decision: 'refuse',
      reason: 'user-authored lessons are eviction-immune',
    };
  }

  if (author === 'agent') {
    return {
      decision: 'evict',
      reason: 'agent-authored, eligible for eviction',
    };
  }

  // Missing or unknown author — default safe.
  return {
    decision: 'refuse',
    reason: `eviction refused: missing or unknown author (got ${JSON.stringify(author)})`,
  };
}

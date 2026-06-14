/**
 * Request-type classification (wg-3d175ec06767).
 *
 * Computes ONE persistent classification per prompt — `research` (understand-only, incl.
 * questions) vs `work` (will-build) — at the harness-neutral pre-dispatch chokepoint
 * (`user-prompt-submit.ts`, which fires under Claude Code AND codex). The record is written to
 * session state and READ by the arm decision (`enter-scoping`) and the stop guards, replacing
 * the fragmented per-rule intent guesses. Two buckets per the locked flow-selection model
 * (question/investigation → research; do-work → coding flow).
 *
 * `classifyRequestType` is PURE (no Date/Math/randomness) — the caller stamps `at`. Cheap-first:
 * deterministic signals decide the clear cases; ambiguous/empty → `confidence:'low'` with the
 * SAFE default `research` (defaulting to `work` would re-arm the codex-pause-wedge this fixes; a
 * genuinely-work turn missed in-session is still caught by the git-owned commit/push gate — the
 * two-layer design). RTC.5 refines low-confidence records via `llm_classify` (pack-side).
 */

export interface RequestTypeRecord {
  type: 'research' | 'work';
  confidence: 'high' | 'low';
  source: 'deterministic' | 'llm';
  prompt_hash: string;
  at: string; // ISO 8601; stamped by the caller (classifyRequestType stays pure)
}

// An imperative work-verb lead — the prompt asks for a build/change.
const WORK_LEAD =
  /\b(build|add|implement|fix|refactor|write|create|ship|rename|delete|remove|migrate|wire|patch|bump|release|update|change|edit)\b/i;
// An investigation verb — understand-only intent.
const INVESTIGATE =
  /\b(look|find|check|why|investigate|explain|compare|review|understand|how\s+does|where\s+is|what\s+is|whats)\b/i;
// Interrogative shape: a leading question word, or a trailing question mark.
const INTERROGATIVE =
  /(^\s*(why|what|how|where|when|who|which|is|are|does|do|did|can|should|could|would|will)\b)|\?\s*$/i;

/**
 * Cheap-first deterministic classification. Precedence: a clear work-lead with no understand
 * signal → `work`; a clear understand signal with no work-lead → `research`; both or neither →
 * `confidence:'low'` with the safe default `research`.
 */
export function classifyRequestType(prompt: string): {
  type: 'research' | 'work';
  confidence: 'high' | 'low';
} {
  const work = WORK_LEAD.test(prompt);
  const understand = INTERROGATIVE.test(prompt) || INVESTIGATE.test(prompt);
  if (work && !understand) return { type: 'work', confidence: 'high' };
  if (understand && !work) return { type: 'research', confidence: 'high' };
  // Conflicting (both) or no signal → low confidence; safe default research (never work).
  return { type: 'research', confidence: 'low' };
}

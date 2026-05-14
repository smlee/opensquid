/**
 * The wedge gate — TS port of `loop-engine`'s `check_promotion_gate`.
 *
 * v0.1 simplified ruleset (matches the load-bearing subset of the
 * Rust gate; we add the tampered-age check when the Rust engine
 * integration brings real filesystem metadata):
 *
 *   1. Body must be ≥ 50 chars  (missing-body)
 *   2. At least one evidence entry  (missing-evidence)
 *   3. thumbs_down must not exceed thumbs_up  (thumbs-down-block)
 *   4. Lesson must be at least 1 hour old  (time-floor)
 *   5. Lesson must not already be in a terminal state  (already-terminal)
 *
 * Pure function. No I/O. Easy to unit-test once we ship tests.
 */

import type { BlockReason, GateDecision, Lesson } from "./types.js";

const MIN_BODY_LENGTH = 50;
const MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

export function checkPromotionGate(lesson: Lesson, now: Date): GateDecision {
  const reasons: BlockReason[] = [];

  if (lesson.status === "promoted" || lesson.status === "discarded" || lesson.status === "superseded") {
    reasons.push({
      kind: "already-terminal",
      detail: `lesson is already in terminal state '${lesson.status}'`,
    });
  }

  if (!lesson.body || lesson.body.trim().length < MIN_BODY_LENGTH) {
    reasons.push({
      kind: "missing-body",
      detail: `body must be at least ${MIN_BODY_LENGTH} characters (got ${lesson.body?.trim().length ?? 0})`,
    });
  }

  if (!lesson.evidence || lesson.evidence.length === 0) {
    reasons.push({
      kind: "missing-evidence",
      detail: "lesson must cite at least one source — a quote or memory reference",
    });
  }

  if (lesson.thumbsDown > lesson.thumbsUp) {
    reasons.push({
      kind: "thumbs-down-block",
      detail: `${lesson.thumbsDown} thumbs-down outweighs ${lesson.thumbsUp} thumbs-up`,
    });
  }

  const created = new Date(lesson.createdAt);
  const ageMs = now.getTime() - created.getTime();
  if (ageMs < MIN_AGE_MS) {
    const remainingMin = Math.ceil((MIN_AGE_MS - ageMs) / 60_000);
    reasons.push({
      kind: "time-floor",
      detail: `lesson is too fresh — wait ~${remainingMin} more minute(s) before promoting`,
    });
  }

  return { promote: reasons.length === 0, reasons };
}

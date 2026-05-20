/**
 * Shared types for the wedge-gate runtime (Phase 7).
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Two-stage wedge gate"
 * + §"Three lesson types × two gates" + §"Context-clearing cycle".
 *
 * The wedge gate is opensquid's strategic moat: lessons captured during the
 * context-clearing cycle (Stage 1, user-validated) only ever mutate a skill
 * if outcome metrics confirm sustained improvement (Stage 2,
 * outcome-validated). Self-grading by an LLM is explicitly disallowed —
 * promotion signals are external (verdict pass rate, user explicit confirm).
 *
 * Three lesson types, two gates (per the design doc):
 *
 *   workflow    — Stage 1 only (user-validated at capture).
 *   preference  — Stage 1 only (user-validated at capture).
 *   skill_upgrade — Stage 1 + Stage 2 (outcome-validated on top of capture).
 *
 * The `PendingLesson` shape is what `capture.ts` writes to disk; downstream
 * promotion (`promote.ts`) consumes outcome signals keyed by the lesson id.
 *
 * Imports from: nothing (leaf type module).
 * Imported by: src/runtime/wedge/capture.ts, src/runtime/wedge/promote.ts,
 *              src/runtime/wedge/automation_buffer.ts.
 */

// ---------------------------------------------------------------------------
// LessonType — three flavors per design doc §"Three lesson types × two gates"
//
// `workflow`     — a missing step or out-of-order step in the user's process
//                  (e.g. "run lint before committing").
// `preference`   — a stable user preference that should bias future choices
//                  (e.g. "always use pnpm, never npm").
// `skill_upgrade` — a behavior change to an existing skill (e.g. add a new
//                  rule, tighten an existing matcher). Requires Stage 2.
// ---------------------------------------------------------------------------

export type LessonType = 'workflow' | 'preference' | 'skill_upgrade';

// ---------------------------------------------------------------------------
// PendingLesson — the on-disk shape captured during the cycle.
//
// `id`           — caller-supplied unique id (uuid or timestamp+random).
// `type`         — see LessonType above.
// `content`      — the lesson body (Markdown allowed in body, NOT in
//                  frontmatter — see capture.ts risk callout).
// `sourceContext` — the conversational context that produced the lesson
//                  (recent turns, tool calls, verdicts).
// `confidence`   — caller's confidence the lesson is real (0..1). The
//                  capture gate does NOT filter on this — it surfaces all
//                  candidates to the user. Filters are the user's job.
// `proposedAt`   — ISO 8601 timestamp. Drives filename ordering.
// `author`       — `'user'` if the user dictated the lesson (eviction-immune
//                  per `feedback_user_authored_lessons_immune`), `'agent'`
//                  if the agent proposed it. Optional at the type layer;
//                  capture defaults to `'agent'`.
// ---------------------------------------------------------------------------

export interface PendingLesson {
  id: string;
  type: LessonType;
  content: string;
  sourceContext: string;
  confidence: number;
  proposedAt: string;
  author?: 'user' | 'agent';
}

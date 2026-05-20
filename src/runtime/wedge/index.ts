/**
 * Wedge-gate runtime barrel.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Two-stage wedge gate".
 *
 * Re-exports the public surface of the wedge-gate runtime. Internal helpers
 * (filename builders, validators) stay private to their owning module.
 *
 * Imports from: ./capture, ./types.
 * Imported by: src/mcp/server.ts, src/runtime/hooks/*.
 */

// Task 7.1
export {
  capturePendingLesson,
  pendingLessonsDir,
  safeTimestamp,
  validatePendingLesson,
} from './capture.js';
export type { LessonType, PendingLesson } from './types.js';

// Task 7.2
export {
  appendBufferEntry,
  walkBuffer,
  bufferDir,
  type BufferCategory,
  type BufferEntry,
} from './automation_buffer.js';

// Task 7.3
export { shouldPromote, type OutcomeSignal, type PromotionThreshold } from './promote.js';

// Task 7.4
export { bumpSkillVersion } from './mutate_skill.js';

// Task 7.5
export { decideEviction, type EvictionDecision } from './eviction.js';

// SCHED.4 — schedule outcome two-stage gate
export {
  captureScheduleOutcome,
  evaluateSchedulePromotion,
  applyScheduleVerdict,
  scheduleOutcomeDir,
  DEFAULT_SCHEDULE_THRESHOLD,
  type ScheduleOutcome,
  type ScheduleVerdict,
  type SchedulePromotionThreshold,
  type ApplyVerdictOpts,
  type ApplyVerdictResult,
} from './schedule_outcome.js';

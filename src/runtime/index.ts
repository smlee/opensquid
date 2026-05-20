/**
 * Runtime: orchestrates the loaded pack set, dispatches events through rule
 * processes, and applies drift response policies.
 *
 * Imports from: functions/, packs/, channels/, secrets/, rag/, models/.
 * Imported by: mcp/, setup/.
 */
export * from './types.js';
export { evaluateProcess } from './evaluator.js';
export { applyDriftResponse } from './drift_response.js';
export { buildRegistry, loadActivePacks } from './bootstrap.js';
export { dispatchEvent, type DispatchResult } from './hooks/dispatch.js';
export { notifyAndPause, isPaused, readPauseState } from './failure_handling.js';
export { Matcher, matchesEvent, normalizeMatcher, clearRegexCache } from './load_matchers.js';
export {
  UnloadCondition,
  shouldUnload,
  normalizeUnloadCondition,
  type TickState,
} from './unload_conditions.js';
export { createTick, advanceTick, resetTick } from './tick.js';
export { prefilterSkills, type PrefilterOptions } from './skill_prefilter.js';
export { routeSkills } from './skill_router.js';
export { partitionSkills, type SkillSet } from './pinned_skills.js';
export { maybeRunDestinationChecks, destinationRuleKey } from './destination_scheduler.js';

// Roll-up drift catalogs across pack layers (Task 5.4) — aggregates each
// pack's `drift-catalog.jsonl` plus the session-level catalog into one
// chronologically sorted view with `pack` provenance preserved. Backs the
// `list_drift_events` MCP tool.
export { readAllDriftCatalogs, type DriftEvent } from './drift_catalog.js';

// Context inheritance filter (Task 6.3) — strips a parent's pack stack to
// only project + matching specialty/domain packs for Mode A subagent
// orchestration. Excludes universal + workflow per design doc §"Team modes".
export { inheritContext } from './context_inherit.js';

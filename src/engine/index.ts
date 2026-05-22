/**
 * Barrel re-export for `opensquid` engine integration.
 *
 * Public surface:
 *   - EngineClient + RpcError + ENGINE_ERROR (`./client.js`)
 *   - resolveEngineBin / setEngineBin / forgetEngineBin / loadEngineConfig
 *     (`./config.js`)
 *   - resolveBundledEngineBin + platform probe helpers (`./resolver.js`)
 *   - registerEngineCli + EngineCliError (`./cli.js`)
 *   - All wire-shape types (`./types.js`)
 */

export { EngineClient, ENGINE_ERROR, RpcError } from './client.js';

export {
  forgetEngineBin,
  loadEngineConfig,
  resolveEngineBin,
  saveEngineConfig,
  setEngineBin,
  type EngineConfig,
} from './config.js';

export {
  binaryNameForPlatform,
  currentPlatform,
  packageForPlatform,
  resolveBundledEngineBin,
  type PlatformProbe,
} from './resolver.js';

export { EngineCliError, registerEngineCli } from './cli.js';

export type {
  CreateMemoryResult,
  GetMemoryResult,
  LessonCaptureFeedbackResult,
  LessonCreateParams,
  LessonCreateResult,
  LessonDiscardResult,
  LessonListResult,
  LessonListRow,
  LessonPromoteResult,
  LessonRecallHit,
  LessonRecallResult,
  LessonSupersedeResult,
  ManifestActiveLesson,
  ManifestAssembleParams,
  ManifestAssembleResult,
  ManifestMemory,
  MemoryDeleteResult,
  MemoryListResult,
  MemoryListRow,
  MemoryOrigin,
  MemoryScope,
  MemorySearchHit,
  MemorySearchParams,
  MemorySearchResult,
  MemoryUpdateResult,
  ScopeFilterWire,
  TaskGetLedgerResult,
  TaskLogPhaseResult,
} from './types.js';

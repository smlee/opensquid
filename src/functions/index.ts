/**
 * Function library: atomic primitives that skills compose into rule processes.
 *
 * The registry is the only path from a skill step to a primitive — packs
 * resolve `function:` refs via `FunctionRegistry.call()`. Primitives live
 * in sibling modules and are registered into a per-runtime instance.
 *
 * Imports from: runtime/types.ts, runtime/result.ts (transitively via registry).
 * Imported by: runtime/, packs/.
 */
export * from './registry.js';
export { registerEventFunctions } from './event.js';
export { registerLessonFunctions } from './lessons.js';
export { registerLlmFunctions } from './llm.js';
export { registerRagFunctions } from './rag.js';
export { registerRecallPreInjectFunction } from './recall_pre_inject.js';
export { registerReadRubric, readRubricContent } from './read_rubric.js';
export { registerRubricPreInject } from './rubric_pre_inject.js';
export { registerProcedurePreInject } from './procedure_pre_inject.js';
export { registerSetRequestType } from './set_request_type.js';
export { buildInjectContext } from './inject_context.js';
export { registerStateFunctions } from './state.js';
export { registerVerdictFunctions } from './verdict.js';
export {
  registerDestinationCheckFunction,
  type CheckDestinationResult,
} from './destination_check.js';
export {
  registerSubagentFunction,
  type RegisterSubagentOptions,
  type SpawnSubagentResult,
  type SubagentDrift,
  type SubagentSdk,
  type SubagentSdkRunResult,
} from './subagent.js';
// AUTO.3 gated primitives — all three flow through `CapabilityGate.check()`
// before any side effect. file_write is the only one with a real impl
// (atomic tmp+rename); shell_exec + http_request are gated stubs that
// AUTO.5 / SCHED.1 wire to spawn + fetch respectively.
export { registerFileWriteFunction } from './file_write.js';
export { registerShellExecFunction } from './shell_exec.js';
export { registerHttpRequestFunction } from './http_request.js';
// Fixed-argv git read (no shell, no injection) — NOT a gated stub like the two above.
export { registerStagedDocsOnlyFunction } from './staged_docs_only.js';
export { registerResetScopeTrackStateFunction } from './reset_scope_track_state.js';
export { registerArmScopeFunction } from './arm_scope.js';

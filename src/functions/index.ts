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
export { registerLlmFunctions } from './llm.js';
export { registerRagFunctions } from './rag.js';
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

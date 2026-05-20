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

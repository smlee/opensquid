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

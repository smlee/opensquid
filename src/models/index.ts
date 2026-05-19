/**
 * Models: model-alias dispatch routing pack-declared aliases to the user's
 * configured backend (subscription CLI, SDK, API, local Ollama, MCP).
 *
 * Imports from: nothing in src/ (sibling layer).
 * Imported by: runtime/, setup/, mcp/, functions/llm.ts.
 */
export type { ModelAliasConfig, ModelImpl, ModelMode, ModelStrategy } from './types.js';
export { resolveStrategy } from './dispatcher.js';
export { loadModelsConfig } from './load_config.js';

/**
 * RAG: pluggable backend dispatching abstract primitives (recall, embed,
 * store_lesson) to libsql-qwen3 default, libsql-lexical fallback (Task 1.11),
 * or adapters (Task 1.12).
 *
 * Public surface: types, the factory, and RRF (so consumers can fuse
 * additional ranked lists if they extend recall). Backends themselves
 * are NOT re-exported — packs route through the factory, never import
 * a concrete backend directly.
 *
 * Imports from: nothing in src/ (sibling layer).
 * Imported by: runtime/, setup/, mcp/.
 */

export type { BackendConfig, QwenWithFallbackOpts } from './backend_factory.js';
export { createBackend, libsqlQwen3WithLexicalFallback } from './backend_factory.js';
export { rrfFuse } from './rrf.js';
export type { Lesson, RagBackend, RecallHit } from './types.js';

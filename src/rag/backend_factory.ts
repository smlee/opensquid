/**
 * RAG backend factory: maps a `BackendConfig` to a concrete `RagBackend`.
 *
 * Phase 1 supports only `libsql-qwen3` (default). Task 1.11 adds
 * `libsql-lexical` (Ollama-less fallback); Task 1.12 adds
 * `claude-auto-memory` (Anthropic auto-memory adapter). Each new backend
 * is one switch arm — the rest of the runtime stays unchanged.
 *
 * `kind` is a string-literal discriminant so future additions don't break
 * existing config files: an unknown `kind` throws a clear error instead
 * of silently selecting a default. Pack manifests that depend on a
 * backend that hasn't shipped yet will fail loudly at load time, which
 * is what we want.
 *
 * Imports from: ./backends/libsql_qwen3.js, ./types.js.
 * Imported by: src/runtime/ (Phase 1 wiring), tests.
 */

import { libsqlQwen3Backend } from './backends/libsql_qwen3.js';

import type { RagBackend } from './types.js';

export interface BackendConfig {
  kind: 'libsql-qwen3';
  dbUrl: string;
  ollamaUrl: string;
  embedderModel?: string;
}

export function createBackend(config: BackendConfig): RagBackend {
  switch (config.kind) {
    case 'libsql-qwen3':
      return libsqlQwen3Backend({
        dbUrl: config.dbUrl,
        ollamaUrl: config.ollamaUrl,
        ...(config.embedderModel === undefined ? {} : { embedderModel: config.embedderModel }),
      });
    default: {
      // Exhaustive check: if `BackendConfig` gains a variant and this arm
      // isn't updated, TS flags `_exhaustive` as not-`never`.
      const _exhaustive: never = config.kind;
      throw new Error(`Unsupported RAG backend: ${String(_exhaustive)}`);
    }
  }
}

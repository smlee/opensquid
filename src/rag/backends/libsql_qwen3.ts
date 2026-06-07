/**
 * `libsql-qwen3` backend = the generalized libSQL store (`libsql_store.ts`) wired with the
 * Ollama-Qwen3 embedder. T-STORE-FOUNDATION-LIBSQL extracted the embedder + the shared backend
 * body into `libsql_store.ts` + `embedders/ollama_qwen3.ts`; this file preserves the original
 * `libsqlQwen3Backend(opts)` signature so `backend_factory.ts` + existing tests are unchanged.
 * Behavior is identical: the `embedderUp` degraded latch now lives in the embedder instance
 * (created once per backend), so it is still shared across recall + storeLesson.
 *
 * Imports from: ../embedders/ollama_qwen3.js, ./libsql_store.js, ../types.js.
 * Imported by: src/rag/backend_factory.ts.
 */
import { ollamaQwen3Embedder } from '../embedders/ollama_qwen3.js';

import { libsqlStoreBackend } from './libsql_store.js';

import type { RagBackend } from '../types.js';

export interface LibsqlQwen3Opts {
  dbUrl: string;
  ollamaUrl: string;
  embedderModel?: string;
}

export function libsqlQwen3Backend(opts: LibsqlQwen3Opts): RagBackend {
  return libsqlStoreBackend({
    dbUrl: opts.dbUrl,
    embedder: ollamaQwen3Embedder({
      ollamaUrl: opts.ollamaUrl,
      ...(opts.embedderModel === undefined ? {} : { model: opts.embedderModel }),
    }),
  });
}

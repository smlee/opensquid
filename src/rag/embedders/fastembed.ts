/**
 * fastembed embedder — in-process text→vector via fastembed-js (bge-small-en-v1.5, 384d).
 * No Ollama, no Python, no daemon (confirmed by spike E0: init ~6.5s one-time model load,
 * ~112ms for 2 strings, dim 384). This is the self-contained OSS-local embedder.
 *
 * The model loads lazily on first `embed()` (the one-time ~6.5s download+load is a startup
 * cost, not per-call) and is cached for the process. `fastembed` is imported dynamically so a
 * host that never selects this embedder pays nothing for the native onnxruntime dependency.
 * Same one-way `up` latch as the Ollama embedder: on failure, degrade to `null` for the session.
 *
 * Imported by: src/rag/backend_factory.ts (the `libsql-fastembed` arm).
 */
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../../runtime/paths.js';

import type { Embedder } from './types.js';

interface FastembedModel {
  embed(texts: string[]): AsyncIterable<number[][]>;
}

// Cache the downloaded model under opensquid's home, NOT the process CWD (fastembed's default
// `local_cache/` would otherwise dump model files into the user's project tree).
function modelCacheDir(): string {
  return join(OPENSQUID_HOME(), 'models');
}

export function fastembedEmbedder(): Embedder {
  let model: FastembedModel | null = null;
  return {
    dim: 384, // bge-small-en-v1.5
    async embed(text: string): Promise<number[] | null> {
      // Per-call failure isolation: a transient embed failure returns null for THIS call only — it must NOT
      // disable subsequent calls (the old one-way `up` latch poisoned whole batches; for in-process fastembed
      // there is no daemon to protect, so the latch had no upside). The lazy `model` cache is preserved.
      try {
        if (model === null) {
          const { FlagEmbedding, EmbeddingModel } = (await import('fastembed')) as unknown as {
            FlagEmbedding: {
              init(opts: { model: unknown; cacheDir?: string }): Promise<FastembedModel>;
            };
            EmbeddingModel: { BGESmallENV15: unknown };
          };
          model = await FlagEmbedding.init({
            model: EmbeddingModel.BGESmallENV15,
            cacheDir: modelCacheDir(),
          });
        }
        for await (const batch of model.embed([text])) {
          const v = batch[0];
          if (v !== undefined) return Array.from(v);
        }
        return null;
      } catch {
        return null; // this call only — no permanent disable
      }
    },
  };
}

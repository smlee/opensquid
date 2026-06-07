/**
 * Ollama/Qwen3 embedder — wraps `ollamaEmbed` as an `Embedder`. Preserves the exact behavior
 * the shipped `libsql_qwen3` backend had inline: a one-way `up` latch that flips to `false` on
 * the first throw (Ollama down / model not pulled / network) so subsequent calls short-circuit
 * to `null` without re-paying worst-case latency for the session.
 *
 * Imports from: ../ollama_client.js, ./types.js.
 * Imported by: src/rag/backend_factory.ts (the `libsql-qwen3` arm).
 */
import { QWEN3_DIM, ollamaEmbed } from '../ollama_client.js';

import type { Embedder } from './types.js';

export function ollamaQwen3Embedder(opts: { ollamaUrl: string; model?: string }): Embedder {
  let up = true;
  return {
    dim: QWEN3_DIM,
    async embed(text: string): Promise<number[] | null> {
      if (!up) return null;
      try {
        return opts.model === undefined
          ? await ollamaEmbed(opts.ollamaUrl, text)
          : await ollamaEmbed(opts.ollamaUrl, text, opts.model);
      } catch {
        up = false;
        return null;
      }
    },
  };
}

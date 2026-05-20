/**
 * `local + ollama` strategy: HTTP POST to a local (or remote) Ollama
 * endpoint's `/api/generate` text-completion route.
 *
 * Model neutrality (per `feedback_stop_haiku_drift`): NO vendor model
 * identifier appears in this file. `cfg.model` is the user-supplied id
 * (an Ollama tag like `qwen2.5-coder:7b` or whatever the user has
 * pulled); opensquid treats it as opaque. We throw if `cfg.model` is
 * unset rather than picking a default — the source code never names a
 * concrete tag.
 *
 * Endpoint: `cfg.endpoint ?? 'http://localhost:11434'`. The default
 * matches Ollama's bind address out of the box; users running it on a
 * remote host or a non-default port set `endpoint` in the alias config.
 *
 * Related file: `src/rag/ollama_client.ts` exposes `ollamaEmbed` against
 * the `/api/embed` route. That client is for the RAG embedder; this
 * strategy is for text generation against `/api/generate`. The request
 * + response shapes are different — we intentionally do NOT share the
 * function. Updates to one MUST NOT silently change the other.
 *
 * `stream: false` is Phase-1 simplicity. Streaming is a follow-up — the
 * model-strategy contract returns one string, so streaming would
 * require either accumulating server-side (defeats streaming) or
 * extending the strategy surface (Phase 2).
 *
 * Test seam: tests pass `opts.fetch` to inject a stub `fetch`. Default
 * uses the global `fetch`.
 *
 * Imports from: ../types.js.
 * Imported by: models/dispatcher.ts.
 */

import type { ModelAliasConfig, ModelStrategy } from '../types.js';

const DEFAULT_ENDPOINT = 'http://localhost:11434';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalOllamaOptions {
  /** Test seam: inject a stub fetch to avoid hitting the network. */
  fetch?: FetchLike;
}

interface OllamaGenerateResponse {
  response: string;
}

export function localOllamaStrategy(
  cfg: ModelAliasConfig,
  opts: LocalOllamaOptions = {},
): ModelStrategy {
  const endpoint = cfg.endpoint ?? DEFAULT_ENDPOINT;
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  return {
    async call(prompt: string): Promise<string> {
      if (!cfg.model) {
        throw new Error('local/ollama strategy: `model` is required in alias config');
      }
      const res = await doFetch(`${endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          prompt,
          stream: false,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${body}`);
      }
      const data = (await res.json()) as OllamaGenerateResponse;
      return data.response;
    },
  };
}

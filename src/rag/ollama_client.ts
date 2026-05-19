/**
 * Minimal Ollama HTTP client for embeddings.
 *
 * Single endpoint: `POST {ollamaUrl}/api/embed` with `{ model, input }`.
 * Returns `embeddings[0]` (Ollama replies `{ embeddings: number[][] }`
 * for `input` — array-of-strings — so we always take the first vector).
 *
 * NO model-name hardcoding in the call site: the caller supplies the
 * model id. The default arg here (`qwen3-embedding:4b`) is the project's
 * chosen embedder per `project_loop_embedder_choice` — this is the
 * embedder choice memory, not the LLM-model-neutrality rule
 * (`feedback_stop_haiku_drift`). The LLM neutrality rule applies to
 * classifier / subagent calls (see src/functions/llm.ts); the embedder
 * is a fixed substrate choice for the default backend.
 *
 * `QWEN3_DIM = 2560` is exported so the libsql backend can pin its
 * F32_BLOB schema column to the right width. Mismatch causes silent
 * insert failures, not row errors — that's the libsql vector contract.
 *
 * Errors: throws on non-2xx HTTP, missing `embeddings` field, or empty
 * vector. The libsql backend catches these to flip `embedderUp = false`.
 *
 * Imports from: nothing (fetch is global in Node 20+).
 * Imported by: src/rag/backends/libsql_qwen3.ts.
 */

export const QWEN3_DIM = 2560;

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

export async function ollamaEmbed(
  ollamaUrl: string,
  text: string,
  model = 'qwen3-embedding:4b',
): Promise<number[]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) {
    throw new Error(`ollamaEmbed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as OllamaEmbedResponse;
  const vec = body.embeddings?.[0];
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error('ollamaEmbed: malformed response (no embeddings[0])');
  }
  return vec;
}

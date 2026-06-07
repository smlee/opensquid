/**
 * Embedder: the injectable text→vector dependency for the libSQL store backend.
 *
 * Extracted (T-STORE-FOUNDATION-LIBSQL) so the shipped libSQL backend is no longer
 * hard-coupled to Ollama/Qwen3 — the only Ollama coupling was the embedder (bounded by the
 * single `{ QWEN3_DIM, ollamaEmbed }` import in libsql_qwen3.ts). Two impls ship:
 * `ollamaQwen3Embedder` (the existing path, behavior preserved) and `fastembedEmbedder`
 * (in-process bge-small, no daemon — the self-contained OSS-local path).
 *
 * `embed()` returns `Promise<number[] | null>` — `null` means the embedder is unavailable
 * (the backend degrades to lexical-only), matching the `RagBackend.embed` contract. `dim` is
 * the vector dimension, used to declare the `F32_BLOB(dim)` column.
 *
 * Imported by: src/rag/backends/libsql_store.ts, src/rag/embedders/*.
 */
export interface Embedder {
  embed(text: string): Promise<number[] | null>;
  readonly dim: number;
}

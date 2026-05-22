/**
 * `recall` MCP tool — search the configured RAG backend for memory hits
 * relevant to a query.
 *
 * This is the 7th read-only MCP tool. Like the other six, it cannot mutate
 * state — mutations (e.g. lesson promotion) stay behind the dispatcher as
 * runtime functions so an external MCP client can never bypass the rule
 * pipeline (T.1.H).
 *
 * Routing: `resolveBackendConfig()` picks the configured backend (env >
 * persisted file > engine-binary-discovery default). For users with the
 * loop-engine binary on PATH this hits the engine daemon's
 * `memory.search` over the T.4 UDS singleton — zero per-call subprocess
 * cost. For users without the binary it falls back to libsql-qwen3.
 *
 * Backend is instantiated per call (cheap — engine connection itself is
 * pooled by `acquireOrSpawnEngine()`). Module-level caching is a
 * deliberate follow-up: keeping the handler stateless avoids cache
 * invalidation when a user rewrites `~/.opensquid/rag-config.json` mid-
 * session.
 *
 * Output formatting matches the other read-only tools — text content,
 * one line per result, score truncated to 3 decimal places, source tag
 * inline so the caller can see whether a hit came from semantic / lexical
 * / fused recall without a second round-trip.
 *
 * Args:
 *   - `query` (required, non-empty string) — natural-language query
 *   - `k` (optional, integer 1..50) — max hits to return; defaults to 10
 *
 * Imports from: ../../rag/backend_factory.js, ../../rag/config.js.
 * Imported by: mcp/server.ts (handler map).
 */

import { createBackend } from '../../rag/backend_factory.js';
import { resolveBackendConfig } from '../../rag/config.js';

export interface RecallArgs {
  query: string;
  k?: number;
}

const DEFAULT_K = 10;

export async function handleRecall(args: RecallArgs): Promise<string> {
  const backendConfig = await resolveBackendConfig();
  const backend = createBackend(backendConfig);
  await backend.init();
  const hits = await backend.recall(args.query, args.k ?? DEFAULT_K);
  if (hits.length === 0) {
    return `No memories found matching "${args.query}".`;
  }
  return hits
    .map((h, i) => `[${i + 1}] (${h.source}, score=${h.score.toFixed(3)}) ${h.lesson.content}`)
    .join('\n\n');
}

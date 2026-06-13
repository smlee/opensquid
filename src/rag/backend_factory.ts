/**
 * RAG backend factory: maps a `BackendConfig` to a concrete `RagBackend`.
 *
 * Phase 1 supports `libsql-qwen3` (hybrid semantic+lexical default) and
 * `libsql-lexical` (FTS5-only fallback, Task 1.11). Task 1.12 will add
 * `claude-auto-memory`. Each new backend is one switch arm — the rest
 * of the runtime stays unchanged.
 *
 * `kind` is a string-literal discriminant so future additions don't break
 * existing config files: an unknown `kind` throws a clear error instead
 * of silently selecting a default. Pack manifests that depend on a
 * backend that hasn't shipped yet will fail loudly at load time, which
 * is what we want.
 *
 * Also exports `libsqlQwen3WithLexicalFallback` — a thin wrapper that
 * starts as qwen3 and swaps to lexical the first time `embed()` returns
 * `null` (Ollama unreachable). Single-direction transition: once swapped,
 * stays swapped for the session, so we don't retry a dead embedder on
 * every call. Replaces the stderr notification with the Task 1.14
 * notification router once that lands — placeholder for now.
 *
 * Imports from: ./backends/libsql_qwen3.js, ./backends/libsql_lexical.js,
 * ./types.js.
 * Imported by: src/runtime/ (Phase 1 wiring), tests.
 */

import { claudeAutoMemoryBackend } from './backends/claude_auto_memory.js';
import { libsqlLexicalBackend } from './backends/libsql_lexical.js';
import { libsqlQwen3Backend } from './backends/libsql_qwen3.js';
import { libsqlStoreBackend } from './backends/libsql_store.js';
import { fastembedEmbedder } from './embedders/fastembed.js';

import type { RagBackend } from './types.js';

export type BackendConfig =
  | {
      kind: 'libsql-qwen3';
      dbUrl: string;
      ollamaUrl: string;
      embedderModel?: string;
    }
  | {
      kind: 'libsql-lexical';
      dbUrl: string;
    }
  | {
      // claude-auto-memory needs no opts — `CLAUDE_PROJECT_DIR` env var
      // is read at init time. Keeping the variant as a marker object
      // means future per-pack overrides (e.g. custom memory subdir) drop
      // in without changing the dispatch signature.
      kind: 'claude-auto-memory';
    }
  | {
      // libsql-fastembed (T-STORE-FOUNDATION-LIBSQL): the generalized libSQL store wired with
      // the in-process fastembed embedder (bge-small 384d) — self-contained, no Ollama. Opt-in
      // via OPENSQUID_RAG_BACKEND=libsql-fastembed; the default backend is unchanged.
      kind: 'libsql-fastembed';
      dbUrl: string;
      // Per-file git source-of-truth dir (T-STORE-PERFILE-SOURCE); the DB is the derived index.
      sourceDir?: string;
    };

export function createBackend(config: BackendConfig): RagBackend {
  switch (config.kind) {
    case 'libsql-qwen3':
      return libsqlQwen3Backend({
        dbUrl: config.dbUrl,
        ollamaUrl: config.ollamaUrl,
        ...(config.embedderModel === undefined ? {} : { embedderModel: config.embedderModel }),
      });
    case 'libsql-lexical':
      return libsqlLexicalBackend({ dbUrl: config.dbUrl });
    case 'claude-auto-memory':
      return claudeAutoMemoryBackend();
    case 'libsql-fastembed':
      return libsqlStoreBackend({
        dbUrl: config.dbUrl,
        embedder: fastembedEmbedder(),
        ...(config.sourceDir === undefined ? {} : { sourceDir: config.sourceDir }),
      });
    default: {
      // Exhaustive check: if `BackendConfig` gains a variant and this arm
      // isn't updated, TS flags `_exhaustive` as not-`never`.
      const _exhaustive: never = config;
      throw new Error(`Unsupported RAG backend: ${String((_exhaustive as { kind: string }).kind)}`);
    }
  }
}

export interface QwenWithFallbackOpts {
  dbUrl: string;
  ollamaUrl: string;
  embedderModel?: string;
}

/**
 * Hybrid wrapper: starts as libsql-qwen3, swaps to libsql-lexical on the
 * first `embed()` that returns `null` (Ollama down). Both backends share
 * the same dbUrl so the lessons table written by the primary remains
 * queryable after the swap.
 *
 * One-way transition by design — retry on every call would burn worst-case
 * latency for the rest of the session if Ollama stays down. If the user
 * restarts Ollama mid-session they can restart the host.
 */
export function libsqlQwen3WithLexicalFallback(opts: QwenWithFallbackOpts): RagBackend {
  const primary = libsqlQwen3Backend({
    dbUrl: opts.dbUrl,
    ollamaUrl: opts.ollamaUrl,
    ...(opts.embedderModel === undefined ? {} : { embedderModel: opts.embedderModel }),
  });
  const fallback = libsqlLexicalBackend({ dbUrl: opts.dbUrl });
  let active: RagBackend = primary;
  let fellBack = false;

  async function swap(): Promise<void> {
    if (fellBack) return;
    // Phase 1 placeholder. Task 1.14 (notification router) replaces this
    // with a real channel-routed alert so users see the swap in their
    // configured Telegram / chat / log destinations.
    process.stderr.write(
      '[opensquid rag] Ollama unavailable; falling back to lexical-only backend\n',
    );
    await fallback.init();
    active = fallback;
    fellBack = true;
  }

  return {
    async init() {
      // Only the primary inits up-front. The fallback's init is deferred
      // until the swap so a healthy session never pays for it. Both
      // backends use `CREATE TABLE IF NOT EXISTS`, so a later swap-time
      // init against the same dbUrl is a no-op against existing tables.
      await active.init();
    },
    async embed(text) {
      if (fellBack) return active.embed(text);
      try {
        const v = await active.embed(text);
        if (v === null) {
          await swap();
          return null;
        }
        return v;
      } catch {
        // Defensive: libsql-qwen3 currently catches its own embedder
        // errors and returns null, but a future backend variant might
        // throw. Either signal triggers the same one-way swap.
        await swap();
        return null;
      }
    },
    async recall(q, k, scope) {
      return active.recall(q, k, scope);
    },
    async storeLesson(l) {
      return active.storeLesson(l);
    },
    async deleteLesson(id, opts) {
      return active.deleteLesson(id, opts);
    },
    // wg-9e4f4eb2a40f: delegate demote to the active backend (no-op if it doesn't implement it).
    async demoteLesson(id) {
      return active.demoteLesson?.(id);
    },
  };
}

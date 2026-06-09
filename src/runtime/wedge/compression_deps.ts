/**
 * Compression consolidate-runner wiring (retire-Rust RES-4c). Binds the RES-4b `consolidate()` deps
 * to the LIVE stack: the RagBackend (recall / deleteLesson / embed), a libSQL client for the
 * memory-store accessors (getMemoryById / insertMemory + the additive compression columns), and the
 * host LLM via `resolveStrategy('reasoning')` for the raw-text summarize. The compression
 * orchestrator (a thin policy caller) takes the returned `run` fn — it stays ignorant of this wiring.
 * The runner owns its libSQL client; the caller `close()`s it after the session's windows.
 *
 * Imports from: @libsql/client, ../../rag/backend_factory.js, ../../rag/config.js,
 *   ../../rag/memory/{consolidate,compress,store}.js, ../../models/{load_config,dispatcher}.js.
 * Imported by: src/runtime/hooks/session-end.ts.
 */
import { createClient } from '@libsql/client';

import { createBackend } from '../../rag/backend_factory.js';
import { resolveBackendConfig } from '../../rag/config.js';
import { resolveStrategy } from '../../models/dispatcher.js';
import { loadModelsConfig } from '../../models/load_config.js';
import {
  consolidate,
  type ConsolidateDeps,
  type ConsolidateOutcome,
} from '../../rag/memory/consolidate.js';
import type { MemoryRow } from '../../rag/memory/compress.js';
import { ensureCompressionColumns, getMemoryById, insertMemory } from '../../rag/memory/store.js';

export interface ConsolidateRunner {
  run: (ids: string[]) => Promise<ConsolidateOutcome>;
  close: () => Promise<void>;
}

/**
 * Build a consolidate runner over the live backend + a fresh libSQL client. Throws if the resolved
 * backend has no `dbUrl` (the memory-store accessors need a libSQL DB — the default libsql-fastembed
 * backend always supplies one). The caller `close()`s the runner after use.
 */
export async function makeConsolidateRunner(): Promise<ConsolidateRunner> {
  const cfg = await resolveBackendConfig();
  if (!('dbUrl' in cfg)) {
    throw new Error(`compression: backend kind "${cfg.kind}" has no dbUrl — cannot consolidate`);
  }
  const dbUrl = cfg.dbUrl; // narrowed to a libsql-* variant
  // File-first source-of-truth (only the fastembed variant carries it) so a consolidated memory
  // survives rebuildLibsqlIndex — see T-fix-compression-durability.
  const sourceDir = 'sourceDir' in cfg ? cfg.sourceDir : undefined;
  const backend = createBackend(cfg);
  await backend.init();
  const client = createClient({ url: dbUrl });
  await ensureCompressionColumns(client);

  const models = await loadModelsConfig();
  const reasoningCfg = models.reasoning;

  const deps: ConsolidateDeps = {
    getMemoryById: (id) => getMemoryById(client, id),
    insertMemory: (m: MemoryRow) => insertMemory(client, m, sourceDir),
    recallIds: (query, k) => backend.recall(query, k).then((hits) => hits.map((h) => h.lesson.id)),
    deleteMemory: (id) => backend.deleteLesson(id, { force: true }).then(() => undefined),
    summarize: (prompt) => {
      if (reasoningCfg === undefined) {
        return Promise.reject(new Error('compression: no "reasoning" model alias configured'));
      }
      return resolveStrategy('reasoning', reasoningCfg).call(prompt);
    },
    embed: (text) => backend.embed(text),
    now: () => new Date(),
  };

  return {
    run: (ids) => consolidate(deps, ids),
    close: () => {
      client.close();
      return Promise.resolve();
    },
  };
}

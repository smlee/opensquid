/**
 * RAG primitives: `recall`, `embed`, `store_lesson`.
 *
 * Skills compose these into rule processes via YAML; the runtime
 * dispatches each call through whichever backend the user configured
 * (libsql-qwen3 default, libsql-lexical fallback, or an adapter — see
 * src/rag/backend_factory.ts).
 *
 * Pluggability boundary: this file imports `RagBackend` ONLY from
 * `../rag/types.js` — no `@libsql/client` types, no embedder-specific
 * imports. A skill that calls `function: recall` doesn't know or care
 * what backend serves the request. Audit rule: keep it that way.
 *
 * Primitive surfaces:
 *
 *   recall({ query, k? = 5 }) → ok(RecallHit[])
 *     Fused semantic + lexical recall. Returns `[]` for empty DB or
 *     queries that match nothing. Errors travel as `runtime` — recall
 *     bugs (driver crash, schema mismatch) shouldn't silently mask
 *     empty results.
 *
 *   embed({ text }) → ok(number[] | null)
 *     `null` means the embedder is unavailable (Ollama down / model
 *     missing). Treat that as a degraded-mode signal, not an error —
 *     `store_lesson` continues to work, recall falls back to lexical.
 *
 *   store_lesson({ id, content, tags?, source?, author? }) → ok(undefined)
 *     Stamps `createdAt` with `new Date().toISOString()` so YAML
 *     authors don't have to compute it. `tags` defaults to `[]`,
 *     `source` to `'unknown'`, `author` to `'agent'` — these match
 *     the most common path (agent-captured candidates during a run).
 *
 * Imports from: zod, ../rag/types.js, ../runtime/result.js, ./registry.js.
 * Imported by: src/functions/index.ts (registry wiring).
 */

import { z } from 'zod';

import type { RagBackend } from '../rag/types.js';
import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Zod arg schemas.
//
// `query` / `text` get `min(1)` to block empty-string foot-guns (an empty
// query against FTS5 is almost always a YAML wiring bug, not user intent).
// `k` is bounded (1..100): the upper bound stops a pack from accidentally
// asking for every row in the DB. `id` / `content` on store_lesson also
// `min(1)` for the same reason.
//
// `author` is the canonical `'user' | 'agent'` enum from RagBackend's
// `Lesson` type — keep them in sync.
// ---------------------------------------------------------------------------

const RecallArgs = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(100).optional(),
});

const EmbedArgs = z.object({
  text: z.string().min(1),
});

const StoreLessonArgs = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  source: z.string().min(1).optional(),
  author: z.enum(['user', 'agent']).optional(),
});

export function registerRagFunctions(registry: FunctionRegistry, backend: RagBackend): void {
  registry.register({
    name: 'recall',
    argSchema: RecallArgs,
    execute: async ({ query, k }) => {
      try {
        const hits = await backend.recall(query, k ?? 5);
        return ok(hits);
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `recall(${query}): ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  registry.register({
    name: 'embed',
    argSchema: EmbedArgs,
    execute: async ({ text }) => {
      try {
        const vec = await backend.embed(text);
        return ok(vec);
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `embed: ${String(e)}`,
          cause: e,
        });
      }
    },
  });

  registry.register({
    name: 'store_lesson',
    argSchema: StoreLessonArgs,
    execute: async ({ id, content, tags, source, author }) => {
      try {
        await backend.storeLesson({
          id,
          content,
          tags: tags ?? [],
          source: source ?? 'unknown',
          author: author ?? 'agent',
          createdAt: new Date().toISOString(),
        });
        return ok(undefined);
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `store_lesson(${id}): ${String(e)}`,
          cause: e,
        });
      }
    },
  });
}

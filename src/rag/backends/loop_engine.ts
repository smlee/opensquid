/**
 * Loop-engine RAG backend — routes RagBackend through the engine daemon's
 * JSON-RPC API (memory.search + memory.create) via the T.4 UDS singleton.
 *
 * Quality: `mode: 'hybrid'` invokes engine-side RRF fusion (K=60, Cormack
 * et al. 2009) — drop-in equivalent to opensquid's `src/rag/rrf.ts:65`
 * per T.1.JJ. No TS-side fusion needed; engine does it server-side over a
 * larger native vector index than libsql's DiskANN.
 *
 * Critical design locks (T.1.B + T.1.#6):
 *
 *  1. **storeLesson → memory.create is INTENTIONAL, not a bug.** Routing
 *     here through `lesson.create` would force every recall-pool write
 *     through the wedge gate's 24h + applied_count=3 + external_signal
 *     promotion requirements (per T.1.F — unsatisfiable in a single
 *     write call, breaks unit tests). RagBackend.storeLesson semantically
 *     stores a recallable memory, NOT a wedge-gated lesson; lesson
 *     lifecycle is a separate surface added in T.6.
 *
 *  2. **Description synthesis is mandatory.** `memory.create` rejects
 *     empty `description` (T.1.B INVALID_PARAMS -32602). Synthesized
 *     from first sentence → first 80 chars → ultimate fallback. Lesson
 *     shape doesn't carry a description field today, so we derive it.
 *
 *  3. **`include_body: true` on every recall.** memory.search's default
 *     `body_preview` is truncated to 240 chars (engine serve.rs); without
 *     this flag RecallHit.lesson.content gets cut mid-sentence.
 *
 *  4. **Source vocab mapping at the boundary.** Engine speaks
 *     `'semantic' | 'text' | 'both'`; RagBackend's RecallHit speaks
 *     `'semantic' | 'lexical' | 'fused'`. The adapter table is the
 *     single point of translation — DO NOT leak engine vocab past it.
 *
 *  5. **Engine schema gap.** `memory.create` doesn't preserve tags /
 *     source / author / createdAt today (T.8 follow-up filed). For v1
 *     we send `description` + `content` only; lesson metadata round-trips
 *     via the Lesson defaults applied by `src/functions/rag.ts:122-145`.
 *
 *  6. **No daemon lifecycle here.** `EngineClient` connects via the T.4
 *     `acquireOrSpawnEngine()` singleton transparently — zero per-call
 *     subprocess cost, cross-session shared engine.
 *
 * Imports from: ../../engine/client.js, ../ollama_client.js, ../types.js.
 * Imported by: src/rag/backend_factory.ts.
 */

import { EngineClient } from '../../engine/client.js';
import { ollamaEmbed } from '../ollama_client.js';

import type { Lesson, RagBackend, RecallHit } from '../types.js';

export interface LoopEngineBackendOpts {
  /** Injected client for tests; production uses the singleton-backed default. */
  client?: EngineClient;
  /** Recall mode. 'hybrid' = engine semantic+text+RRF (default, matches
   *  libsql-qwen3 quality per T.1.JJ). 'semantic' = vector only. 'text' =
   *  pure text-match. */
  mode?: 'semantic' | 'text' | 'hybrid';
  /** Ollama URL for embed() — only used when a rule asks for a raw vector
   *  via the `embed` primitive. Engine handles embedding internally for
   *  memory.create + memory.search. */
  ollamaUrl?: string;
}

export function loopEngineBackend(opts: LoopEngineBackendOpts = {}): RagBackend {
  const client = opts.client ?? new EngineClient();
  const mode = opts.mode ?? 'hybrid';
  const ollamaUrl = opts.ollamaUrl ?? 'http://localhost:11434';

  return {
    async init() {
      // Ensures engine daemon is up + connected before any primitive call.
      // Singleton handles spawn-or-acquire; ping confirms the handshake.
      await client.ping();
    },

    async embed(text: string) {
      // RagBackend contract says embedder-unavailable returns null, not
      // throws (T.1.T). ollamaEmbed throws on HTTP / malformed response;
      // we translate.
      try {
        return await ollamaEmbed(ollamaUrl, text);
      } catch {
        return null;
      }
    },

    async recall(query: string, k: number): Promise<RecallHit[]> {
      const result = await client.memorySearch({
        query,
        limit: k,
        mode,
        include_body: true,
      });

      return result.results.map((h) => ({
        lesson: {
          id: h.id,
          content: h.body_preview,
          tags: [],
          source: 'unknown',
          author: 'user' as const,
          createdAt: '',
        },
        score: h.similarity,
        source: mapEngineSource(h.source),
      }));
    },

    async storeLesson(lesson: Lesson): Promise<void> {
      const description = synthesizeDescription(lesson.content);
      await client.memoryCreate({
        description,
        content: lesson.content,
      });
    },
  };
}

/**
 * Derive a non-empty description from lesson content. Engine rejects
 * empty descriptions with INVALID_PARAMS -32602 (T.1.B). Algorithm:
 *   1. First sentence (split on `.!?\n`), trimmed, capped at 80 chars
 *   2. Fallback: first 80 chars of raw content (for sentence-free text)
 *   3. Ultimate fallback: `'untitled memory'` (empty-content edge case)
 *
 * 80 chars chosen to match engine's description display budget without
 * truncation in `manifest.assemble` output (engine serve.rs body_preview).
 */
function synthesizeDescription(content: string): string {
  const firstSentence = content.split(/[.!?\n]/)[0]?.trim() ?? content;
  return firstSentence.slice(0, 80) || content.slice(0, 80) || 'untitled memory';
}

/**
 * Translate engine source vocabulary into RagBackend RecallHit vocabulary.
 * Engine uses `'semantic' | 'text' | 'both'` (only present in hybrid
 * results); opensquid uses `'semantic' | 'lexical' | 'fused'`. When
 * engine omits source (non-hybrid modes), default to `'semantic'` —
 * matches the dominant recall-from-vector path.
 */
function mapEngineSource(s?: 'semantic' | 'text' | 'both'): 'semantic' | 'lexical' | 'fused' {
  switch (s) {
    case 'semantic':
      return 'semantic';
    case 'text':
      return 'lexical';
    case 'both':
      return 'fused';
    default:
      return 'semantic';
  }
}

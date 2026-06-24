/**
 * Always-on raw-turn capture into the RAG store — the write side of T-memory-foundation (design §5:282-285,
 * "always recording, word-for-word, never trimmed at capture time").
 *
 * Reads the FULL transcript and upserts every message entry through the public `RagBackend.storeLesson`,
 * keyed by the entry `uuid` (per-message-unique + stable): re-scans dedupe (idempotent upsert) AND a Stop
 * that failed to fire is backfilled on the next scan. Rows are `author:'agent'` — RECLAIMABLE raw working
 * memory; immunity (`author:'user'`) is reserved for VERIFIED policy written via `memorize`.
 */
import type { Lesson, RagBackend, RecallScope } from '../types.js';
import { classifyDurability } from '../durability.js';
import { resolveRecallScope } from '../scope.js';
import { readTranscriptEntries, type TranscriptMessageEntry } from './transcript_entries.js';

export interface IngestDeps {
  /** Already-`init()`'d backend (the caller owns construction + init). */
  backend: RagBackend;
  transcriptPath: string;
  /** The session's working dir (from the Stop payload) — authoritative for project scope; a hook's own
   *  `process.cwd()` is not reliable (cf. `memory_reconcile.ts`, `stop_drive.ts`). Falls back to
   *  `process.cwd()` when absent. */
  cwd?: string;
  // Seams for tests:
  readEntries?: (path: string) => Promise<TranscriptMessageEntry[]>;
  resolveScope?: () => Promise<RecallScope>;
}

function lessonFromEntry(e: TranscriptMessageEntry, namespace: string | null): Lesson {
  const tags = [`role:${e.role}`];
  if (e.hasTool) tags.push('role:tool'); // provenance the two-value `author` can't carry
  // The user's OWN words are eviction-IMMUNE (design §5:287 "anything you said is immune" + the standing
  // never-silently-prune axiom): a genuine user-prose turn ⇒ `author:'user'`, which consolidate/sweepRetired/
  // deleteLesson all already spare. A `role:user` entry that carries tool blocks is a tool-RESULT delivery
  // (the harness encodes tool results as role:user), NOT the human's words ⇒ it stays `author:'agent'`. So
  // assistant output + tool I/O (the voluminous part) remain RECLAIMABLE — immunity here does not reintroduce
  // unbounded growth. (Verified policy via `memorize` is a separate, also-immune tier.)
  const isUserAuthored = e.role === 'user' && !e.hasTool;
  return {
    id: e.uuid, // per-message-unique + stable ⇒ idempotent upsert AND no identical-text collapse
    content: e.content,
    tags,
    source: 'turn-ingest',
    author: isUserAuthored ? 'user' : 'agent',
    createdAt: e.timestamp,
    tier: 'project', // a turn is about the working repo (mirrors memorize)
    namespace,
    durability: classifyDurability(e.content), // plain ⇒ durable; HANDOFF/RESUME/TO SHIP ⇒ point_in_time
  };
}

/**
 * Capture the conversation into RAG. Returns the number of rows written. Idempotent by `uuid`, so safe to
 * call on every Stop. The caller is responsible for fail-open behavior (see `runtime/hooks/stop_ingest.ts`).
 */
export async function ingestTurn(deps: IngestDeps): Promise<number> {
  const readEntries = deps.readEntries ?? readTranscriptEntries;
  // Thread the payload cwd to the scope resolver (project-scope is per working repo); `resolveRecallScope`
  // falls back to `process.cwd()` when `cwd` is undefined.
  const resolveScope = deps.resolveScope ?? (() => resolveRecallScope(deps.cwd ?? process.cwd()));
  const entries = await readEntries(deps.transcriptPath);
  if (entries.length === 0) return 0;
  const { namespace } = await resolveScope();
  for (const e of entries) {
    await deps.backend.storeLesson(lessonFromEntry(e, namespace));
  }
  return entries.length;
}

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
  // Seams for tests:
  readEntries?: (path: string) => Promise<TranscriptMessageEntry[]>;
  resolveScope?: () => Promise<RecallScope>;
}

function lessonFromEntry(e: TranscriptMessageEntry, namespace: string | null): Lesson {
  const tags = [`role:${e.role}`];
  if (e.hasTool) tags.push('role:tool'); // provenance the two-value `author` can't carry
  return {
    id: e.uuid, // per-message-unique + stable ⇒ idempotent upsert AND no identical-text collapse
    content: e.content,
    tags,
    source: 'turn-ingest',
    author: 'agent', // RECLAIMABLE raw capture — immunity is reserved for verified policy
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
  const resolveScope = deps.resolveScope ?? resolveRecallScope;
  const entries = await readEntries(deps.transcriptPath);
  if (entries.length === 0) return 0;
  const { namespace } = await resolveScope();
  for (const e of entries) {
    await deps.backend.storeLesson(lessonFromEntry(e, namespace));
  }
  return entries.length;
}

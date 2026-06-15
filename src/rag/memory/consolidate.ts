/**
 * Memory consolidation (retire-Rust RES-4b; port of engine compress.rs `consolidate`). The D2 safety
 * contract: compress a window → Mc, VERIFY (recall-replay) that Mc preserves each predecessor's
 * recall, and ONLY THEN force-delete the NON-immune predecessors. Fail-closed on ANY uncertainty
 * (recall_k==0, a vanished predecessor, a search error, or Mc absent from the top-k) → delete
 * NOTHING; Mc lives alongside the originals and the caller surfaces drift.
 *
 * The citation-counter immunity (`consumed_by_user_lessons > 0`) is checked HERE, re-loaded right
 * before the irreversible delete — NOT delegated to the force-delete (which would bypass it). The
 * delete MUST go through the backend `deleteLesson(force:true)` so the per-file source is removed too;
 * a DB-only delete would let `rebuildLibsqlIndex` resurrect the predecessor, undoing the consolidation.
 *
 * Imports from: ./compress.js.
 * Imported by: RES-4c (the compression orchestrator) — not yet wired.
 */
import { compress, type CompressDeps, type MemoryRow } from './compress.js';

/** Top-k for the recall-replay probe — engine DEFAULT_CONSOLIDATE_RECALL_K (compress.rs:252). */
export const DEFAULT_CONSOLIDATE_RECALL_K = 5;

export interface ConsolidateDeps extends CompressDeps {
  /** Backend recall → the hit ids (e.g. `recall(q,k).then(hs => hs.map(h => h.lesson.id))`). */
  recallIds: (query: string, k: number) => Promise<string[]>;
  /** Backend `demoteLesson(id)` (wg-9e4f4eb2a40f) — sets `retired_at` (out of recall) and retains the
   *  row + per-file source as the rollback floor. NOT a hard delete; slice 3's sweeper deletes later. */
  demoteMemory: (id: string) => Promise<void>;
}

export interface ConsolidateOutcome {
  mcId: string;
  deleted: string[];
  keptImmune: string[];
  verified: boolean;
}

/** Representative recall-probe text for a predecessor (compress.rs:456-466). libSQL memory is
 * content-only (compress folds description into the content head), so the first line — falling back
 * to the content — capped at 200 chars is the representative query. */
function recallQueryFor(m: MemoryRow): string {
  const head = m.content.trim().split('\n')[0]?.trim() ?? '';
  return (head.length > 0 ? head : m.content.trim()).slice(0, 200);
}

export async function consolidate(
  deps: ConsolidateDeps,
  ids: string[],
  recallK: number = DEFAULT_CONSOLIDATE_RECALL_K,
): Promise<ConsolidateOutcome> {
  const unique = [...new Set(ids)];

  // 1. compress → Mc. Errors propagate — NOTHING is deleted (we never reach the delete phase).
  const mc = await compress(deps, unique);

  // 2. recall-replay verify. Fail-closed: recallK==0, vanished predecessor, search error, or Mc absent.
  let verified = recallK > 0;
  for (const pid of unique) {
    if (!verified) break;
    const pred = await deps.getMemoryById(pid);
    if (pred === null) {
      verified = false;
      break;
    }
    let hits: string[];
    try {
      hits = await deps.recallIds(recallQueryFor(pred), recallK);
    } catch {
      verified = false;
      break;
    }
    if (!hits.includes(mc.id)) {
      verified = false;
      break;
    }
  }

  // 3. fail-closed: a verify miss deletes NOTHING. Mc lives alongside the predecessors.
  if (!verified) return { mcId: mc.id, deleted: [], keptImmune: [], verified: false };

  // 4. gated DEMOTE (wg-9e4f4eb2a40f) — RE-LOAD the authoritative citation counter right before the
  // (reversible) demotion. `deleted` holds the ids removed from the live recall surface — now via
  // demotion (retired_at), NOT a hard delete; the rows + per-file sources are retained as the
  // rollback floor, and slice 3's sweeper hard-deletes them after 30 untouched days.
  const deleted: string[] = [];
  const keptImmune: string[] = [];
  for (const pid of unique) {
    const reloaded = await deps.getMemoryById(pid);
    // Absent/unreadable → treat as immune-safe (never touch the unconfirmable). Immunity =
    // user-authored OR citation-counted: user memory is NEVER demoted (the locked "long-term/user
    // memory is never auto-removed" principle holds at the causal site — RSW.1, wg-9e4f4eb2a40f),
    // and a cited memory stays live as before.
    const immune =
      reloaded === null ? true : reloaded.author === 'user' || reloaded.consumedByUserLessons > 0;
    if (immune) {
      keptImmune.push(pid);
      continue;
    }
    try {
      await deps.demoteMemory(pid);
      deleted.push(pid);
    } catch {
      keptImmune.push(pid); // a demote error is non-fatal — keep it live; Mc preserves the trace
    }
  }
  return { mcId: mc.id, deleted, keptImmune, verified: true };
}

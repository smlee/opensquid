/**
 * CFD.2 / AD.5 — the backlog list (the nice-to-have route).
 *
 * SCOPE-time additions classed "nice-to-have" by rubric §5 are DEFERRED here — a durable, per-session,
 * append-only jsonl awaiting the user's confirmation (NOT silently dropped, NOT silently folded into scope).
 * Surfaced at a BOUNDARY (a stop hook), never mid-flow — pre-research §4.2: "the flow cannot stop once scope
 * is complete." `addedAt` is stamped by the CALLER (kept out of this module so reads are deterministic in
 * tests). `readBacklog` dedups by id (a re-add collapses) so a boundary surfacing does not repeat an item.
 *
 * Spec: docs/tasks/T-anti-drift-gate.md AD.5; pre-research §4.2, §5.6.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionLogFile } from '../paths.js';

/** The per-session jsonl name (sessionLogFile → `<name>.jsonl`). */
export const BACKLOG_LOG = 'anti-drift-backlog';

export interface BacklogItem {
  id: string;
  text: string;
  cls: 'nice_to_have';
  addedAt: string; // ISO 8601 — stamped by the caller
}

function isBacklogItem(v: unknown): v is BacklogItem {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as BacklogItem).id === 'string' &&
    typeof (v as BacklogItem).text === 'string' &&
    (v as BacklogItem).cls === 'nice_to_have' &&
    typeof (v as BacklogItem).addedAt === 'string'
  );
}

/** Append a nice-to-have to the backlog (append-only jsonl). */
export async function appendBacklog(sessionId: string, item: BacklogItem): Promise<void> {
  const path = sessionLogFile(sessionId, BACKLOG_LOG);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(item)}\n`, 'utf8');
}

/** Read the backlog, deduped by id (latest wins, first-seen order). Absent / malformed-line → skipped. */
export async function readBacklog(sessionId: string): Promise<BacklogItem[]> {
  let raw: string;
  try {
    raw = await readFile(sessionLogFile(sessionId, BACKLOG_LOG), 'utf8');
  } catch {
    return []; // absent → empty
  }
  const byId = new Map<string, BacklogItem>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isBacklogItem(parsed)) byId.set(parsed.id, parsed); // dedup by id (latest wins)
    } catch {
      /* skip a malformed line — never break the surfacing */
    }
  }
  return [...byId.values()];
}

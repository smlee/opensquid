/**
 * T2.8 — durable acceptance items (zero LLM), the human half of the DEPLOY touchpoint.
 *
 * The DEPLOY stage's `accept` decision is the 2nd/last human touchpoint: it must NEVER auto-declare "shipped"
 * (design §6.2-6.3). The acceptance signal is therefore DURABLE — an append-only jsonl under the session state
 * dir that SURVIVES a closed session and re-surfaces at start-up (handoff/render.ts). The flow only ships when a
 * "waiting-for-OK" item is explicitly MARKED accepted; an absent/waiting item loops the FSM back to PLAN.
 *
 * Append-only (never rewrite): each `markAccepted` appends a NEW record for the same id; `readAcceptance`
 * collapses by id LAST-WRITER-WINS. Pure shapes — `iso` is passed in (no `Date.now` in the record producers),
 * so the unit tests are deterministic. FILE lives under the per-session state dir (test-isolated via the
 * globalSetup OPENSQUID_HOME temp).
 *
 * Spec: docs/tasks/T-v2-track2-discipline.md T2.8.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sessionStateFile } from '../paths.js';

export interface AcceptanceItem {
  id: string;
  taskId: string;
  status: 'waiting' | 'accepted' | 'rejected';
  addedAt: string;
}

const FILE = (sid: string): string => sessionStateFile(sid, 'fsf-acceptance.jsonl');

/** Append-only jsonl write → DURABLE across session close (the record is never rewritten in place). */
export async function appendAcceptance(sid: string, item: AcceptanceItem): Promise<void> {
  const f = FILE(sid);
  await mkdir(dirname(f), { recursive: true });
  await appendFile(f, JSON.stringify(item) + '\n', 'utf8');
}

/** Read the collapsed acceptance set — LAST-WRITER-WINS by id (a missing file → empty). */
export async function readAcceptance(sid: string): Promise<AcceptanceItem[]> {
  const raw = await readFile(FILE(sid), 'utf8').catch(() => '');
  const byId = new Map<string, AcceptanceItem>();
  for (const ln of raw.split('\n').filter(Boolean)) {
    const it = JSON.parse(ln) as AcceptanceItem;
    byId.set(it.id, it); // last-writer-wins
  }
  return [...byId.values()];
}

/** Mark a waiting item accepted by appending an updated record (`iso` passed in — deterministic). */
export async function markAccepted(sid: string, id: string, iso: string): Promise<void> {
  const cur = (await readAcceptance(sid)).find((i) => i.id === id);
  if (cur) await appendAcceptance(sid, { ...cur, status: 'accepted', addedAt: iso });
}

/** The items still awaiting a human OK (the start-up surface re-asks on these). */
export async function waitingItems(sid: string): Promise<AcceptanceItem[]> {
  return (await readAcceptance(sid)).filter((i) => i.status === 'waiting');
}

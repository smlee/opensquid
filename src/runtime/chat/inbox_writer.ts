/**
 * Durable writers for `acked.jsonl` (T-L3-LOOP LL.4). Append-only writes
 * + mutex-guarded rewrite-and-replace for the periodic 7-day purge.
 *
 * Mutex via `proper-lockfile` (already an opensquid dep — used by
 * `src/runtime/daemon.ts` for PID locking). Lock file lives next to
 * acked.jsonl as `acked.jsonl.lock`; contention is rare (single UPS fire
 * per session) but possible if a stale background process retains a
 * writer.
 *
 * proper-lockfile requires the target file to EXIST before acquiring the
 * lock; we touch via empty `appendFile('')` on the first call before the
 * lock acquisition.
 *
 * Keyed by UMBRELLA (T-CHAT-AS-TERMINAL CAT.1c) — was per-cwd project_uuid;
 * the ack ledger now lives under `umbrellas/<id>/inbox/acked.jsonl`.
 *
 * Imports from: node:fs/promises, node:path, proper-lockfile, ../paths.
 * Imported by: src/runtime/hooks/user-prompt-submit.ts (LL.4 drain block).
 */

import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import { umbrellaInboxAckedPath } from '../paths.js';

import type { AckRow } from './inbox.js';

const LOCK_OPTS = {
  retries: { retries: 5, factor: 2, minTimeout: 50 },
};

/**
 * Append a batch of AckRows to the umbrella's acked.jsonl under a
 * proper-lockfile mutex. No-op for empty input. Creates parent dir +
 * touches the target file on first call (proper-lockfile requires
 * existence).
 */
export async function appendAckRows(umbrellaId: string, rows: readonly AckRow[]): Promise<void> {
  if (rows.length === 0) return;
  const path = umbrellaInboxAckedPath(umbrellaId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, '');
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await appendFile(path, body, 'utf8');
  } finally {
    await release();
  }
}

/**
 * Atomic rewrite of acked.jsonl after a 7-day purge dropped some rows.
 * Mutex-guarded. Writes to `.tmp` then renames so a reader never observes
 * a half-written file. Empty `kept` produces an empty file (cleared).
 */
export async function rewriteAckedAfterPurge(
  umbrellaId: string,
  kept: readonly AckRow[],
): Promise<void> {
  const path = umbrellaInboxAckedPath(umbrellaId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, '');
  const release = await lockfile.lock(path, LOCK_OPTS);
  try {
    const tmp = `${path}.tmp`;
    const body = kept.length === 0 ? '' : kept.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  } finally {
    await release();
  }
}

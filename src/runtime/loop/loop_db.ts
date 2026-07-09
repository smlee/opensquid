/**
 * LSF.1/LSF.2/LSF.5 — the shared opener for the loop-status feature's durable stores.
 *
 * The push-stream monitor log (`loop_events`, LMP.1) and the metrics history (`loop_metrics`, LSF.5) live in the
 * SAME libsql store the task checkpoints use — the PROJECT-LOCAL `<root>/.opensquid/opensquid.db` (`loopDbUrl`),
 * co-located with `task_checkpoints` (T-project-local-state PLS.3; subprocess-harness-push.md §1 UPDATE).
 * Co-locating them means the whole loop-status data layer relocates in one move, never split across two stores.
 * The url is deliberately the SAME string `loop_stage.ts`'s `checkpointDbUrl()` computes (both resolve the local
 * store via `resolveLocalStoreDir`, honoring the `OPENSQUID_PROJECT_ROOT` test override) — the two openers
 * resolve to one file so a read sees every writer's rows. RAG/recall + the daemon `audit_log` stay GLOBAL: this
 * is a TABLE split, not a file move.
 *
 * Every open applies the shared WAL + busy_timeout posture (`applyConcurrencyPragmas`, AWAITED) so a headless
 * lap / the daemon / a concurrent CLI read never trips `SQLITE_BUSY`. Mirrors `withTaskCheckpointStore`.
 *
 * Imports from: node:path, @libsql/client, ../paths.js, ../../storage/sqlite_concurrency.js.
 * Imported by: ./loop_events.ts, ./loop_metrics.ts.
 */
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';

import { resolveLocalStoreDir } from '../paths.js';
import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';

/** The PROJECT-LOCAL libsql url the loop-status stores share with `task_checkpoints`:
 *  `<root>/.opensquid/opensquid.db`, resolved by walking up from cwd for the nearest `.opensquid/` (honors the
 *  `OPENSQUID_PROJECT_ROOT` test override). THROWS outside a project store — no global fallback (that fallback is
 *  the partition PLS removes). The daemon `audit_log` + RAG stay GLOBAL: a TABLE split, not a file move. */
export async function loopDbUrl(): Promise<string> {
  return `file:${join(await resolveLocalStoreDir(process.cwd()), 'opensquid.db')}`;
}

/**
 * Open a short-lived libsql client against {@link loopDbUrl} with the shared concurrency posture, run `fn`, and
 * ALWAYS close the client. The posture is AWAITED (not fire-and-forget) so `busy_timeout` is in force before the
 * first read/write. `fn` receives the resolved store URL too (already computed here) so a consumer can memoize
 * per-store one-time work — e.g. the `loop_events` DDL guard — WITHOUT re-walking `resolveLocalStoreDir`.
 */
export async function withLoopDb<T>(fn: (db: Client, url: string) => Promise<T>): Promise<T> {
  const url = await loopDbUrl();
  const client = createClient({ url });
  await applyConcurrencyPragmas(client);
  try {
    return await fn(client, url);
  } finally {
    try {
      client.close();
    } catch {
      /* already closed / close error — nothing actionable */
    }
  }
}

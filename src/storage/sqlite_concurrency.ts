/**
 * The ONE shared libsql concurrency posture for opensquid's single-file databases (WAL + busy_timeout).
 *
 * opensquid opens `~/.opensquid/opensquid.db` from many processes at once — the always-on daemon (audit log),
 * a ralph lap's hook subprocess (the task-checkpoint trigger), the RAG ingest hook, and every `opensquid`
 * CLI verb. Under the default rollback-journal mode a second writer that meets a held write lock throws
 * `SQLITE_BUSY` immediately. This helper installs the posture every opensquid.db connection must carry:
 *
 *   - `PRAGMA busy_timeout=5000` — a contended writer WAITS up to 5s for the lock instead of throwing.
 *     Per-connection, so EVERY opener must set it (a single bare connection can still throw).
 *   - `PRAGMA journal_mode=WAL`  — readers never block writers (and vice-versa). WAL is a persistent,
 *     db-FILE-level property (the first connection to set it converts the file; the rest observe it), so
 *     this is best-effort: the conversion itself can transiently hit `SQLITE_BUSY`, which we TOLERATE
 *     (the next opener converts it) — never throwing the caller's path.
 *
 * NEVER THROWS. Both pragmas are individually try/caught, so a caller can `await applyConcurrencyPragmas(c)`
 * (the posture is guaranteed set before the first write — used where an async seam exists: the daemon, the
 * new task-checkpoint client) OR fire-and-forget `void applyConcurrencyPragmas(c)` from a synchronous client
 * factory (the CLI `defaultOpen` helpers). Fire-and-forget is safe because libsql serializes statements on a
 * single connection: the `busy_timeout` execute queues ahead of any subsequent write on that same connection.
 *
 * Location: `src/storage/` alongside `atomic_file.ts` — a cross-cutting persistence helper importable by
 * runtime/, setup/cli/, and rag/ without creating a layering cycle (it depends only on the libsql type).
 *
 * Imports from: @libsql/client (type only).
 * Imported by: every opensquid.db opener (daemon, checkpoints/trace/audit/cost/cache/limits/memory CLIs,
 *   the rag libsql backends, and the v2-supply task-checkpoint client).
 */
import type { Client } from '@libsql/client';

/**
 * Install the WAL + busy_timeout posture on `client`. Best-effort + never-throws: a failed WAL conversion
 * (transient SQLITE_BUSY) is tolerated because WAL is persistent at the db-file level — the next opener
 * completes the conversion. Awaitable for openers with an async seam; fire-and-forget (`void`) for sync
 * factories (the internal catches prevent an unhandled rejection).
 */
export async function applyConcurrencyPragmas(client: Client): Promise<void> {
  try {
    await client.execute('PRAGMA busy_timeout=5000');
  } catch {
    /* best-effort: a connection that can't set busy_timeout still works, just without the wait */
  }
  try {
    await client.execute('PRAGMA journal_mode=WAL');
  } catch {
    /* tolerate SQLITE_BUSY during the WAL conversion — WAL is db-file-level; the next opener converts it */
  }
}

import { withLoopDb } from './loop_db.js';
import { resolveCheckpointKey } from './checkpoint_key.js';

export interface DurableTaskAuditEntry {
  readonly hash: string;
  readonly verdict: string;
  readonly subjectHash?: string;
}

const initialized = new Map<string, Promise<void>>();

async function ensureTable(): Promise<void> {
  await withLoopDb(async (db, url) => {
    let ready = initialized.get(url);
    if (ready === undefined) {
      ready = db
        .execute(
          `CREATE TABLE IF NOT EXISTS task_audit_cache (
          task_id TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          entry_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (task_id, cache_key)
        )`,
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          initialized.delete(url);
          throw error;
        });
      initialized.set(url, ready);
    }
    await ready;
  });
}

function parseEntry(value: unknown): DurableTaskAuditEntry | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { hash?: unknown }).hash !== 'string' ||
    typeof (value as { verdict?: unknown }).verdict !== 'string'
  ) {
    return null;
  }
  const subjectHash = (value as { subjectHash?: unknown }).subjectHash;
  return {
    hash: (value as { hash: string }).hash,
    verdict: (value as { verdict: string }).verdict,
    ...(typeof subjectHash === 'string' ? { subjectHash } : {}),
  };
}

/** Persist an opaque pack audit cache under durable task identity so a fresh per-stage lap can re-use it. */
export async function writeTaskAuditCache(
  sessionId: string,
  cacheKey: string,
  entry: DurableTaskAuditEntry,
): Promise<void> {
  const taskId = await resolveCheckpointKey(sessionId);
  await ensureTable();
  await withLoopDb(async (db) => {
    await db.execute({
      sql: `INSERT INTO task_audit_cache (task_id, cache_key, entry_json, updated_at_ms)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(task_id, cache_key) DO UPDATE SET
              entry_json=excluded.entry_json, updated_at_ms=excluded.updated_at_ms`,
      args: [taskId, cacheKey, JSON.stringify(entry), Date.now()],
    });
  });
}

/** Read the latest opaque audit cache for this task; malformed/absent state is a cache miss. */
export async function readTaskAuditCache(
  sessionId: string,
  cacheKey: string,
): Promise<DurableTaskAuditEntry | null> {
  const taskId = await resolveCheckpointKey(sessionId);
  await ensureTable();
  return withLoopDb(async (db) => {
    const rs = await db.execute({
      sql: 'SELECT entry_json FROM task_audit_cache WHERE task_id=? AND cache_key=?',
      args: [taskId, cacheKey],
    });
    const text = rs.rows[0]?.entry_json;
    if (typeof text !== 'string') return null;
    try {
      return parseEntry(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  });
}

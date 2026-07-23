import {
  parseAuditEvidenceEntry,
  type AuditEvidenceEntry,
  type AuditEvidenceFailure,
  type AuditLensVerdict,
} from './audit_evidence.js';
import { withLoopDb } from './loop_db.js';
import { resolveCheckpointKey } from './checkpoint_key.js';

export type DurableTaskAuditLens = AuditLensVerdict;
export type DurableTaskAuditFailure = AuditEvidenceFailure;
export type DurableTaskAuditEntry = AuditEvidenceEntry;

export interface DurableTaskAuditAttempt {
  readonly entry: DurableTaskAuditEntry;
  readonly updatedAtMs: number;
}

const initialized = new Map<string, Promise<void>>();

async function ensureTable(): Promise<void> {
  await withLoopDb(async (db, url) => {
    let ready = initialized.get(url);
    if (ready === undefined) {
      ready = db
        .batch(
          [
            `CREATE TABLE IF NOT EXISTS task_audit_cache (
              task_id TEXT NOT NULL,
              cache_key TEXT NOT NULL,
              entry_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY (task_id, cache_key)
            )`,
            `CREATE TABLE IF NOT EXISTS task_audit_history (
              attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL,
              cache_key TEXT NOT NULL,
              entry_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_task_audit_history_lookup
              ON task_audit_history(task_id, cache_key, attempt_id DESC)`,
          ],
          'write',
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
  return parseAuditEvidenceEntry(value);
}

/** Persist an opaque pack audit cache under durable task identity so a fresh per-stage lap can re-use it. */
export async function writeTaskAuditCache(
  sessionId: string,
  cacheKey: string,
  entry: DurableTaskAuditEntry,
): Promise<void> {
  const taskId = await resolveCheckpointKey(sessionId);
  await ensureTable();
  const validated = parseEntry(entry);
  if (validated === null) throw new Error('refusing malformed task audit evidence');
  await withLoopDb(async (db) => {
    const encoded = JSON.stringify(validated);
    const now = Date.now();
    await db.batch(
      [
        {
          sql: `INSERT INTO task_audit_cache (task_id, cache_key, entry_json, updated_at_ms)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(task_id, cache_key) DO UPDATE SET
                  entry_json=excluded.entry_json, updated_at_ms=excluded.updated_at_ms`,
          args: [taskId, cacheKey, encoded, now],
        },
        {
          sql: `INSERT INTO task_audit_history (task_id, cache_key, entry_json, updated_at_ms)
                VALUES (?, ?, ?, ?)`,
          args: [taskId, cacheKey, encoded, now],
        },
        {
          sql: `DELETE FROM task_audit_history
                WHERE task_id=? AND cache_key=? AND attempt_id NOT IN (
                  SELECT attempt_id FROM task_audit_history
                  WHERE task_id=? AND cache_key=?
                  ORDER BY attempt_id DESC LIMIT 100
                )`,
          args: [taskId, cacheKey, taskId, cacheKey],
        },
      ],
      'write',
    );
  });
}

/** Read the latest opaque audit cache by canonical task identity. */
export async function readTaskAuditCacheForTask(
  taskId: string,
  cacheKey: string,
): Promise<DurableTaskAuditEntry | null> {
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

/** Read the latest opaque audit cache for this session's task; malformed/absent state is a cache miss. */
export async function readTaskAuditCache(
  sessionId: string,
  cacheKey: string,
): Promise<DurableTaskAuditEntry | null> {
  const taskId = await resolveCheckpointKey(sessionId);
  return taskId === null ? null : readTaskAuditCacheForTask(taskId, cacheKey);
}

/** Read recent immutable audit attempts by canonical task identity. */
export async function readTaskAuditHistoryForTask(
  taskId: string,
  cacheKey: string,
  limit = 20,
): Promise<readonly DurableTaskAuditAttempt[]> {
  await ensureTable();
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
  return withLoopDb(async (db) => {
    const rs = await db.execute({
      sql: `SELECT entry_json, updated_at_ms
            FROM task_audit_history
            WHERE task_id=? AND cache_key=?
            ORDER BY attempt_id DESC
            LIMIT ?`,
      args: [taskId, cacheKey, boundedLimit],
    });
    return rs.rows.flatMap((row) => {
      if (typeof row.entry_json !== 'string' || typeof row.updated_at_ms !== 'number') return [];
      try {
        const entry = parseEntry(JSON.parse(row.entry_json) as unknown);
        return entry === null ? [] : [{ entry, updatedAtMs: row.updated_at_ms }];
      } catch {
        return [];
      }
    });
  });
}

/** Read recent immutable attempts for this session's task. */
export async function readTaskAuditHistory(
  sessionId: string,
  cacheKey: string,
  limit = 20,
): Promise<readonly DurableTaskAuditAttempt[]> {
  const taskId = await resolveCheckpointKey(sessionId);
  return taskId === null ? [] : readTaskAuditHistoryForTask(taskId, cacheKey, limit);
}

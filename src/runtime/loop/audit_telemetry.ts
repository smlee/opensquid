import { z } from 'zod';

import { AuditLensIdSchema } from '../audit_schema.js';
import { withLoopDb } from './loop_db.js';

const AUDIT_TELEMETRY_PER_SESSION = 1_000;
const AUDIT_TELEMETRY_GLOBAL = 10_000;

const AuditTelemetryEntrySchema = z
  .object({
    at: z.string().datetime(),
    model: z.string().min(1).max(256),
    operation: z.enum(['cache_read', 'model_call']),
    status: z.enum(['hit', 'returned', 'timeout', 'error']),
    duration_ms: z.number().finite().nonnegative(),
    lens: AuditLensIdSchema.optional(),
  })
  .strict();

export type AuditTelemetryEntry = z.infer<typeof AuditTelemetryEntrySchema>;

async function ensureTable(): Promise<void> {
  // SQLite owns schema truth. IF NOT EXISTS is idempotent and avoids a second URL-keyed lifecycle cache.
  await withLoopDb(async (db) => {
    await db.batch(
      [
        `CREATE TABLE IF NOT EXISTS audit_spawn_telemetry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          entry_json TEXT NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_audit_spawn_telemetry_session
          ON audit_spawn_telemetry(session_id, id DESC)`,
      ],
      'write',
    );
  });
}

/** Non-authorizing model/cache operation facts with deterministic per-session and global retention. */
export async function appendAuditTelemetry(
  sessionId: string,
  rawEntry: AuditTelemetryEntry,
): Promise<void> {
  const entry = AuditTelemetryEntrySchema.parse(rawEntry);
  await ensureTable();
  await withLoopDb(async (db) => {
    await db.batch(
      [
        {
          sql: 'INSERT INTO audit_spawn_telemetry (session_id, entry_json) VALUES (?, ?)',
          args: [sessionId, JSON.stringify(entry)],
        },
        {
          sql: `DELETE FROM audit_spawn_telemetry
                WHERE session_id=? AND id NOT IN (
                  SELECT id FROM audit_spawn_telemetry
                  WHERE session_id=? ORDER BY id DESC LIMIT ?
                )`,
          args: [sessionId, sessionId, AUDIT_TELEMETRY_PER_SESSION],
        },
        {
          sql: `DELETE FROM audit_spawn_telemetry
                WHERE id NOT IN (
                  SELECT id FROM audit_spawn_telemetry ORDER BY id DESC LIMIT ?
                )`,
          args: [AUDIT_TELEMETRY_GLOBAL],
        },
      ],
      'write',
    );
  });
}

/** Stable bounded reader for tests and handoff display; callers never access telemetry SQL/schema. */
export async function readAuditTelemetryTail(
  sessionId: string,
  limit = 5,
): Promise<AuditTelemetryEntry[]> {
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(1_000, limit)) : 5;
  await ensureTable();
  return withLoopDb(async (db) => {
    const rs = await db.execute({
      sql: `SELECT entry_json FROM audit_spawn_telemetry
            WHERE session_id=? ORDER BY id DESC LIMIT ?`,
      args: [sessionId, boundedLimit],
    });
    return rs.rows
      .flatMap((row) => {
        if (typeof row.entry_json !== 'string') return [];
        try {
          const parsed = AuditTelemetryEntrySchema.safeParse(JSON.parse(row.entry_json) as unknown);
          return parsed.success ? [parsed.data] : [];
        } catch {
          return [];
        }
      })
      .reverse();
  });
}

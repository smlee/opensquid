/**
 * Unified audit log (CLI.5).
 *
 * Single libsql `audit_log` table consolidating every audit-emit point
 * in the daemon: AUTO.3 capability gate, SCHED.1 webhook server,
 * SCHED.x schedule fires, DURABLE.4 resumer, channel_send, and the
 * SEC.6 queued-shell-exec approval loop (`pending_shell` — the only
 * category whose rows mutate post-write via `transitionPending`).
 *
 * Discipline:
 *   - `detail_json` carries the category-specific payload — NEVER PII.
 *     Producers MUST pre-hash sensitive values via `hashDetailValue`
 *     (signing secrets, bearer tokens, URLs with creds). See per-
 *     category callsites for the hash boundary.
 *   - `(category, occurred_at_ms)` index covers every time-windowed
 *     query the CLI exposes (sub-100ms/1M rows acceptance criterion).
 *   - Pending approval: `transitionPending` is a single UPDATE WHERE
 *     decision='prompted' — SQLite-atomic, so two racing approvals
 *     yield exactly one `rowsAffected === 1`; the loser refuses to
 *     fire the queued shell_exec twice.
 *   - Tail: libsql has no CDC; polling cursor over `occurred_at_ms`,
 *     exits on `signal.aborted`. Same posture as TraceReader.tail.
 */

import { createHash } from 'node:crypto';

import type { Client } from '@libsql/client';

/** Locked category enum. `pending_shell` is the only mutable category. */
export type AuditCategory =
  | 'capability_gate'
  | 'webhook'
  | 'schedule'
  | 'resume'
  | 'channel_send'
  | 'pending_shell';

/** Locked decision enum. `prompted` + `approved` + `rejected` are reserved
 *  for the `pending_shell` state machine. */
export type AuditDecision =
  | 'allowed'
  | 'denied'
  | 'prompted'
  | 'success'
  | 'error'
  | 'approved'
  | 'rejected';

export interface AuditEntry {
  occurredAtMs: number;
  category: AuditCategory;
  decision: AuditDecision;
  packId?: string;
  skill?: string;
  ruleId?: string;
  /** Category-specific payload. Sensitive values MUST be pre-hashed. */
  detail: Record<string, unknown>;
}

/** Read-back row — carries `id` so `approve/reject <id>` have a handle. */
export interface AuditRow extends AuditEntry {
  id: number;
}

export interface QueryOpts {
  sinceMs?: number;
  category?: AuditCategory;
  decision?: AuditDecision;
  /** Cap result set; default 100. `Number.POSITIVE_INFINITY` → no cap. */
  limit?: number;
}

export interface TailOpts {
  /** Cursor — only rows with `occurred_at_ms > sinceMs` are emitted. */
  sinceMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  category?: AuditCategory;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at_ms INTEGER NOT NULL,
    category TEXT NOT NULL,
    decision TEXT NOT NULL,
    pack_id TEXT,
    skill TEXT,
    rule_id TEXT,
    detail_json TEXT NOT NULL
  );
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_audit_occurred_category
    ON audit_log(category, occurred_at_ms);
`;

const DEFAULT_TAIL_INTERVAL_MS = 1000;
const MIN_TAIL_INTERVAL_MS = 100;
const DEFAULT_QUERY_LIMIT = 100;

export class AuditLog {
  private initialized = false;

  constructor(private readonly db: Client) {}

  /** Idempotent DDL — same posture as CheckpointStore.init (DURABLE.1). */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.execute(CREATE_TABLE_SQL);
    await this.db.execute(CREATE_INDEX_SQL);
    this.initialized = true;
  }

  /** Append one entry. `detail` is JSON-encoded as-is — producers pre-hash
   *  sensitive fields via `hashDetailValue` (the log doesn't know which). */
  async append(entry: AuditEntry): Promise<void> {
    await this.init();
    await this.db.execute({
      sql: `INSERT INTO audit_log
              (occurred_at_ms, category, decision, pack_id, skill, rule_id, detail_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.occurredAtMs,
        entry.category,
        entry.decision,
        entry.packId ?? null,
        entry.skill ?? null,
        entry.ruleId ?? null,
        JSON.stringify(entry.detail),
      ],
    });
  }

  /** Time-windowed query. `idx_audit_occurred_category` covers category +
   *  sinceMs; decision is a post-index filter. Returns newest-first. */
  async query(opts: QueryOpts = {}): Promise<AuditRow[]> {
    await this.init();
    const filters: string[] = [];
    const args: (string | number)[] = [];
    if (opts.category !== undefined) {
      filters.push('category = ?');
      args.push(opts.category);
    }
    if (opts.sinceMs !== undefined) {
      filters.push('occurred_at_ms >= ?');
      args.push(opts.sinceMs);
    }
    if (opts.decision !== undefined) {
      filters.push('decision = ?');
      args.push(opts.decision);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const limit =
      opts.limit === undefined
        ? DEFAULT_QUERY_LIMIT
        : Number.isFinite(opts.limit)
          ? opts.limit
          : -1;
    const limitClause = limit > 0 ? `LIMIT ${String(Math.floor(limit))}` : '';
    const rs = await this.db.execute({
      sql: `SELECT id, occurred_at_ms, category, decision, pack_id, skill, rule_id, detail_json
            FROM audit_log
            ${where}
            ORDER BY occurred_at_ms DESC, id DESC
            ${limitClause}`,
      args,
    });
    return rs.rows.map(rowToAuditRow);
  }

  /** Live tail. Polling cursor over `occurred_at_ms`. Exits on
   *  `signal.aborted` — caller owns the AbortController so SIGINT cleans
   *  up cleanly (see audit.ts tail action). */
  async tail(opts: TailOpts = {}): Promise<AsyncIterable<AuditRow>> {
    await this.init();
    const interval = Math.max(MIN_TAIL_INTERVAL_MS, opts.intervalMs ?? DEFAULT_TAIL_INTERVAL_MS);
    let cursor = opts.sinceMs ?? Date.now();
    const category = opts.category;
    const signal = opts.signal;
    const db = this.db;

    async function* gen(): AsyncIterable<AuditRow> {
      while (!signal?.aborted) {
        const filters: string[] = ['occurred_at_ms > ?'];
        const args: (string | number)[] = [cursor];
        if (category !== undefined) {
          filters.push('category = ?');
          args.push(category);
        }
        const rs = await db.execute({
          sql: `SELECT id, occurred_at_ms, category, decision, pack_id, skill, rule_id, detail_json
                FROM audit_log
                WHERE ${filters.join(' AND ')}
                ORDER BY occurred_at_ms ASC, id ASC`,
          args,
        });
        for (const r of rs.rows) {
          const row = rowToAuditRow(r);
          if (row.occurredAtMs > cursor) cursor = row.occurredAtMs;
          yield row;
        }
        if (signal?.aborted) return;
        await sleep(interval, signal);
      }
    }

    return gen();
  }

  /** Atomic `prompted → approved|rejected` transition. Returns `true` on
   *  the single winning row (`rowsAffected === 1`); `false` when the row
   *  is already resolved (race loser) or doesn't exist. */
  async transitionPending(id: number, to: 'approved' | 'rejected'): Promise<boolean> {
    await this.init();
    const rs = await this.db.execute({
      sql: `UPDATE audit_log
            SET decision = ?
            WHERE id = ? AND category = 'pending_shell' AND decision = 'prompted'`,
      args: [to, id],
    });
    return Number(rs.rowsAffected) === 1;
  }
}

/** Hash a sensitive raw value for `detail` (SHA-256, first 16 hex chars).
 *  Use for: signing secrets, bearer tokens, URLs with query-string creds,
 *  any value that could leak PII downstream. Not invertible. */
export function hashDetailValue(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

// Row → AuditRow. libsql cells narrow through Record<string, unknown>.
function rowToAuditRow(row: unknown): AuditRow {
  const r = row as Record<string, unknown>;
  const detailJson = typeof r.detail_json === 'string' ? r.detail_json : '{}';
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(detailJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed JSON → empty detail (defensive — INSERT path always
       writes valid JSON; only corruption could reach this branch). */
  }
  const out: AuditRow = {
    id: Number(r.id),
    occurredAtMs: Number(r.occurred_at_ms),
    category: String(r.category) as AuditCategory,
    decision: String(r.decision) as AuditDecision,
    detail,
  };
  if (typeof r.pack_id === 'string') out.packId = r.pack_id;
  if (typeof r.skill === 'string') out.skill = r.skill;
  if (typeof r.rule_id === 'string') out.ruleId = r.rule_id;
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * LSF.5 — the project-local `loop_metrics` DB: the durable cost/performance HISTORY (subprocess-harness-push.md
 * §3a). Live status = the present; this = the time series. A FOLD-INTO-DB layer over data that ALREADY exists
 * (per-lap cost/tokens/duration from the lap-log envelope; per-stage timing from the stage-advance boundary;
 * harness/auth_mode from ralph.config) — NOT new capture.
 *
 * CORE MECHANISM (numbers, timestamps, token counts — NO stage vocabulary): the table, the writer, and the
 * generic SQL read/aggregate. The `stage` column stores whatever OPAQUE string the caller passes (the PACK
 * supplies the label a row is bucketed under); core assigns it no meaning. Storage is co-located with the
 * checkpoints (project-local per §1 UPDATE — moves with them).
 *
 * GRAIN: one row per STAGE (the user's ask). Per-LOOP totals = SUM over a run's stage rows ({@link aggregatePerLoop}).
 * Explicitly NOT scoped (would be drift): per-LAP rows, per-PHASE metrics, per-MODEL token breakdown.
 *
 * `cost_usd` is NOTIONAL and ALWAYS recorded — NEVER gated on `auth_mode === 'api'`. Even on a subscription
 * (no per-token dollar cost) the notional cost + token counts are recorded so the user can gauge what a run
 * WOULD cost.
 *
 * Imports from: @libsql/client, ./loop_db.js.
 * Imported by: src/runtime/ralph/orchestrator.ts (the stage-advance writer wire), src/cli/loop_status.ts (`--metrics`).
 */
import type { Client } from '@libsql/client';

import { withLoopDb } from './loop_db.js';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS loop_metrics (
    run_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    harness TEXT NOT NULL,
    auth_mode TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL
  );
`;

// Indexed exactly on the columns the UI + `--metrics` filter/aggregate by (§3a), so those reads stay cheap.
const CREATE_INDEXES_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_loop_metrics_started_at ON loop_metrics(started_at_ms);`,
  `CREATE INDEX IF NOT EXISTS idx_loop_metrics_item ON loop_metrics(item_id);`,
  `CREATE INDEX IF NOT EXISTS idx_loop_metrics_harness ON loop_metrics(harness);`,
];

/** One per-STAGE metrics row (§3a schema). `costUsd` is notional (always recorded). */
export interface LoopMetricRow {
  runId: string;
  itemId: string;
  stage: string;
  harness: string;
  authMode: 'api' | 'subscription';
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** The SQL-filterable read (§3a): `--since` window + optional task/harness narrowing, most-recent first. */
export interface MetricsFilter {
  sinceMs?: number;
  itemId?: string;
  harness?: string;
}

/** One per-LOOP aggregate row — SUM over a run's per-stage rows (per-loop = the aggregate of its stages). */
export interface LoopAggregateRow {
  runId: string;
  harness: string;
  authMode: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  stages: number;
}

/** Narrow a libsql text column to a string (libsql values are `unknown`-typed; blind `String()` on a non-string
 *  can stringify an object as `[object Object]`). Text columns are NOT NULL in the schema, so `''` is unreachable. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function ensureSchema(db: Client): Promise<void> {
  await db.execute(CREATE_TABLE_SQL);
  for (const sql of CREATE_INDEXES_SQL) await db.execute(sql);
}

/**
 * Record ONE per-stage metrics row. Notional cost + tokens are always written (no auth-mode gate). The `stage`
 * label is passed through verbatim (pack policy — core stores the opaque string).
 */
export async function recordStageMetric(row: LoopMetricRow): Promise<void> {
  await withLoopDb(async (db) => {
    await ensureSchema(db);
    await db.execute({
      sql: `INSERT INTO loop_metrics
              (run_id, item_id, stage, harness, auth_mode,
               started_at_ms, ended_at_ms, duration_ms, cost_usd, input_tokens, output_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.runId,
        row.itemId,
        row.stage,
        row.harness,
        row.authMode,
        row.startedAtMs,
        row.endedAtMs,
        row.durationMs,
        row.costUsd,
        row.inputTokens,
        row.outputTokens,
      ],
    });
  });
}

function whereClause(filter: MetricsFilter): { sql: string; args: (string | number)[] } {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (filter.sinceMs !== undefined) {
    clauses.push('started_at_ms >= ?');
    args.push(filter.sinceMs);
  }
  if (filter.itemId !== undefined) {
    clauses.push('item_id = ?');
    args.push(filter.itemId);
  }
  if (filter.harness !== undefined) {
    clauses.push('harness = ?');
    args.push(filter.harness);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

/** The per-STAGE read — every matching row, most-recent first. Cheap via the `(started_at_ms)` index. */
export async function readMetrics(filter: MetricsFilter = {}): Promise<LoopMetricRow[]> {
  return withLoopDb(async (db) => {
    await ensureSchema(db);
    const { sql, args } = whereClause(filter);
    const rs = await db.execute({
      sql: `SELECT run_id, item_id, stage, harness, auth_mode, started_at_ms, ended_at_ms,
                   duration_ms, cost_usd, input_tokens, output_tokens
            FROM loop_metrics ${sql}
            ORDER BY started_at_ms DESC`,
      args,
    });
    return rs.rows.map((r) => ({
      runId: str(r.run_id),
      itemId: str(r.item_id),
      stage: str(r.stage),
      harness: str(r.harness),
      authMode: r.auth_mode === 'api' ? 'api' : 'subscription',
      startedAtMs: Number(r.started_at_ms),
      endedAtMs: Number(r.ended_at_ms),
      durationMs: Number(r.duration_ms),
      costUsd: Number(r.cost_usd),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    }));
  });
}

/** The per-LOOP read — the same rows SUM-aggregated by `run_id` (per-loop = SUM over its stage rows). */
export async function aggregatePerLoop(filter: MetricsFilter = {}): Promise<LoopAggregateRow[]> {
  return withLoopDb(async (db) => {
    await ensureSchema(db);
    const { sql, args } = whereClause(filter);
    const rs = await db.execute({
      sql: `SELECT run_id, harness, auth_mode,
                   MIN(started_at_ms) AS started_at_ms,
                   MAX(ended_at_ms)   AS ended_at_ms,
                   SUM(duration_ms)   AS duration_ms,
                   SUM(cost_usd)      AS cost_usd,
                   SUM(input_tokens)  AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   COUNT(*)           AS stages
            FROM loop_metrics ${sql}
            GROUP BY run_id
            ORDER BY started_at_ms DESC`,
      args,
    });
    return rs.rows.map((r) => ({
      runId: str(r.run_id),
      harness: str(r.harness),
      authMode: str(r.auth_mode),
      startedAtMs: Number(r.started_at_ms),
      endedAtMs: Number(r.ended_at_ms),
      durationMs: Number(r.duration_ms),
      costUsd: Number(r.cost_usd),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      stages: Number(r.stages),
    }));
  });
}

/**
 * Durable-execution checkpoint store (DURABLE.1).
 *
 * Every durable primitive call writes one row keyed by `(run_id, step_idx)`.
 * On resume the evaluator queries `lastCompletedStep` + `loadBindings` to
 * restore the `as:` variable scope and skip already-completed steps. The
 * per-primitive boundary (finer than LangGraph's per-node, looser than
 * Temporal's per-activity-with-manual-marks) is the architectural moat:
 * `process:` is already a sequence of atomic primitive calls, so we get
 * resumable execution for free without asking pack authors to annotate
 * anything.
 *
 * Scope of DURABLE.1: STORAGE ONLY. This module ships the table, the
 * `append` / `lastCompletedStep` / `loadBindings` / `pruneOlderThan` API,
 * and canonical-JSON round-trip. It does NOT wire the evaluator. DURABLE.2
 * adds the `durable: boolean` flag to `PrimitiveDescriptor` and wraps each
 * primitive call in the evaluator.
 *
 * Atomicity: every `append` is a single `INSERT OR REPLACE` — SQLite makes
 * single-statement writes atomic, so no explicit BEGIN/COMMIT is needed.
 * `INSERT OR REPLACE` (rather than plain INSERT) gives us the idempotent
 * retry semantics: a primitive that errored at step 3 records
 * `status='errored'`; the resume retries step 3 and overwrites that row
 * with the new outcome. Replay-with-same-input writes the same row a
 * second time without corruption.
 *
 * Fail-mode: any libsql error in `append` re-throws (caller decides). We
 * do NOT swallow errors and continue — silent fail-open on checkpoint
 * write would defeat the entire feature (a crash after the "successful"
 * primitive but before a missing checkpoint would skip the step on
 * resume, breaking exactly-once semantics).
 *
 * Imports from: @libsql/client, ./canonical_json.js.
 * Imported by: DURABLE.2 evaluator wrap, DURABLE.4 resumer, future
 * `opensquid checkpoints` CLI.
 */

import type { Client } from '@libsql/client';

import { canonicalJsonParse, canonicalJsonStringify } from './canonical_json.js';

/**
 * Args to `append`. Mirrors the `checkpoints` row 1:1 except `outputs`
 * arrives as an unknown JS value — the store handles canonical-JSON
 * encoding.
 */
export interface CheckpointWrite {
  runId: string;
  stepIdx: number;
  fn: string;
  inputsHash: string;
  outputs: unknown;
  /** Variable name the step's `as:` clause binds to. `undefined` if no binding. */
  asBinding?: string;
  startedAtMs: number;
  completedAtMs: number;
  status: 'completed' | 'errored';
  /** Set when `status === 'errored'`; null otherwise. */
  errorMessage?: string;
}

/**
 * One row read back from the store. `outputs` has already been
 * canonical-JSON-revived (base64 → Buffer; ISO date strings stay strings).
 */
export interface CheckpointRow {
  runId: string;
  stepIdx: number;
  fn: string;
  inputsHash: string;
  outputs: unknown;
  asBinding: string | undefined;
  startedAtMs: number;
  completedAtMs: number;
  status: 'completed' | 'errored';
  errorMessage: string | undefined;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    run_id TEXT NOT NULL,
    step_idx INTEGER NOT NULL,
    fn TEXT NOT NULL,
    inputs_hash TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    as_binding TEXT,
    started_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    PRIMARY KEY (run_id, step_idx)
  );
`;

const CREATE_INDEX_RUN_ID_SQL = `
  CREATE INDEX IF NOT EXISTS idx_checkpoints_run_id ON checkpoints(run_id);
`;

const CREATE_INDEX_COMPLETED_AT_SQL = `
  CREATE INDEX IF NOT EXISTS idx_checkpoints_completed_at ON checkpoints(completed_at_ms);
`;

export class CheckpointStore {
  private initialized = false;

  constructor(private readonly db: Client) {}

  /**
   * Idempotent DDL — `CREATE TABLE IF NOT EXISTS` + indexes. Same posture
   * as `RateLimiter.init` (AUTO.2) and the libsql RAG backends. Safe to
   * call repeatedly; only the first call hits libsql.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.db.execute(CREATE_TABLE_SQL);
    await this.db.execute(CREATE_INDEX_RUN_ID_SQL);
    await this.db.execute(CREATE_INDEX_COMPLETED_AT_SQL);
    this.initialized = true;
  }

  /**
   * Atomic write of a single checkpoint row. `INSERT OR REPLACE` makes
   * the call idempotent on `(run_id, step_idx)` — a retried step
   * overwrites its prior errored row with the new outcome, and a
   * replay-with-same-inputs writes the same row twice without corruption.
   *
   * Throws on libsql error. The caller (evaluator in DURABLE.2) is the
   * right place to decide fail-closed vs fail-open semantics; the store
   * never silently swallows.
   */
  async append(write: CheckpointWrite): Promise<void> {
    await this.init();
    const outputsJson = canonicalJsonStringify(write.outputs);
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO checkpoints
              (run_id, step_idx, fn, inputs_hash, outputs_json, as_binding,
               started_at_ms, completed_at_ms, status, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        write.runId,
        write.stepIdx,
        write.fn,
        write.inputsHash,
        outputsJson,
        write.asBinding ?? null,
        write.startedAtMs,
        write.completedAtMs,
        write.status,
        write.errorMessage ?? null,
      ],
    });
  }

  /**
   * Highest step_idx for which the run has a `status='completed'` row.
   * Errored rows are excluded so the resume cursor naturally re-runs
   * errored steps (the spec's retry-not-skip rule).
   *
   * Returns `null` when the run has no completed steps yet — caller starts
   * the process from `step_idx = 0`.
   */
  async lastCompletedStep(runId: string): Promise<CheckpointRow | null> {
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT run_id, step_idx, fn, inputs_hash, outputs_json, as_binding,
                   started_at_ms, completed_at_ms, status, error_message
            FROM checkpoints
            WHERE run_id = ? AND status = 'completed'
            ORDER BY step_idx DESC
            LIMIT 1`,
      args: [runId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return rowToCheckpoint(row);
  }

  /**
   * Replay every `status='completed'` checkpoint that owns an `as:`
   * binding into a name→value map. The evaluator hydrates its
   * `ctx.bindings` from this map before resuming.
   *
   * Errored steps and steps without `asBinding` are skipped — they
   * contribute nothing to the rule's variable scope.
   *
   * Order: ascending `step_idx`. If two completed steps somehow share a
   * binding name (a primitive author bug — the same `as:` reused in two
   * places), the later step's value wins, matching the in-memory
   * evaluator semantics.
   */
  async loadBindings(runId: string): Promise<Record<string, unknown>> {
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT as_binding, outputs_json
            FROM checkpoints
            WHERE run_id = ? AND status = 'completed' AND as_binding IS NOT NULL
            ORDER BY step_idx ASC`,
      args: [runId],
    });
    const out: Record<string, unknown> = {};
    for (const row of rs.rows) {
      const asBinding = row.as_binding;
      const outputsJson = row.outputs_json;
      if (typeof asBinding !== 'string' || typeof outputsJson !== 'string') continue;
      out[asBinding] = canonicalJsonParse(outputsJson);
    }
    return out;
  }

  /**
   * Fetch every row for a run in ascending `step_idx` order. Used by the
   * evaluator's checkpoint wrap (DURABLE.2) to build a per-step lookup map
   * once at process entry, then dispatch each durable step against the
   * pre-fetched row without per-step libsql queries.
   *
   * Returns BOTH completed and errored rows — the evaluator decides what to
   * do with each: completed + matching inputsHash → skip; everything else
   * → re-execute and overwrite via `INSERT OR REPLACE`.
   *
   * Returns `[]` when the run has no checkpoints (fresh run).
   */
  async fetchRun(runId: string): Promise<CheckpointRow[]> {
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT run_id, step_idx, fn, inputs_hash, outputs_json, as_binding,
                   started_at_ms, completed_at_ms, status, error_message
            FROM checkpoints
            WHERE run_id = ?
            ORDER BY step_idx ASC`,
      args: [runId],
    });
    return rs.rows.map(rowToCheckpoint);
  }

  /**
   * Delete every row whose `completed_at_ms` falls before `now - ms`.
   * Returns the affected-row count for audit-log surfacing. Used by the
   * future `opensquid checkpoints clean --older-than 7d` CLI verb.
   *
   * `nowMs` is optional and injected for tests; production callers pass
   * `Date.now()`.
   */
  async pruneOlderThan(ms: number, nowMs: number = Date.now()): Promise<number> {
    await this.init();
    const cutoff = nowMs - ms;
    const rs = await this.db.execute({
      sql: `DELETE FROM checkpoints WHERE completed_at_ms < ?`,
      args: [cutoff],
    });
    return Number(rs.rowsAffected);
  }
}

/**
 * Map a libsql row to the typed `CheckpointRow`. `outputs_json` round-trips
 * through `canonicalJsonParse` so base64 envelopes restore as Buffers.
 */
function rowToCheckpoint(row: Record<string, unknown>): CheckpointRow {
  const status = row.status === 'errored' ? 'errored' : 'completed';
  const asBindingRaw = row.as_binding;
  const errorRaw = row.error_message;
  const outputsJsonRaw = row.outputs_json;
  return {
    runId: String(row.run_id),
    stepIdx: Number(row.step_idx),
    fn: String(row.fn),
    inputsHash: String(row.inputs_hash),
    outputs: typeof outputsJsonRaw === 'string' ? canonicalJsonParse(outputsJsonRaw) : null,
    asBinding: typeof asBindingRaw === 'string' ? asBindingRaw : undefined,
    startedAtMs: Number(row.started_at_ms),
    completedAtMs: Number(row.completed_at_ms),
    status,
    errorMessage: typeof errorRaw === 'string' ? errorRaw : undefined,
  };
}

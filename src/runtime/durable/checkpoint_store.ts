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

/**
 * Identity of a run captured at process entry. The Resumer (DURABLE.4)
 * needs `(packId, skill, ruleId, eventKind, eventPayload, packVersion)` to
 * reconstruct a `ProcessContext` on resume — the checkpoint table only
 * stores the hashed `inputsHash`, never the raw event payload, so the
 * manifest is the load-bearing record for restart.
 *
 * `packVersion` is compared at resume time to detect drift; if the pack
 * version diverges between crash and resume the run is skipped + audited
 * (see Resumer.resume).
 */
export interface RunManifest {
  runId: string;
  packId: string;
  packVersion: string;
  skill: string;
  ruleId: string;
  eventKind: string;
  eventPayload: unknown;
  startedAtMs: number;
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

// ---------------------------------------------------------------------------
// `run_manifests` — one row per run-start. Written by the rule dispatcher
// before it calls evaluateProcess; consumed by the Resumer (DURABLE.4) to
// reconstruct the ProcessContext for an interrupted run.
//
// `event_payload_json` is the canonical-JSON encoding of the inbound event
// payload that triggered the run. Storing it here is what lets us replay
// across daemon restart — the checkpoint rows themselves only carry the
// hashed `inputsHash` of each primitive's args, not the original event.
// ---------------------------------------------------------------------------

const CREATE_TABLE_MANIFESTS_SQL = `
  CREATE TABLE IF NOT EXISTS run_manifests (
    run_id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    pack_version TEXT NOT NULL,
    skill TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    event_payload_json TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL
  );
`;

const CREATE_INDEX_MANIFEST_STARTED_AT_SQL = `
  CREATE INDEX IF NOT EXISTS idx_run_manifests_started_at ON run_manifests(started_at_ms);
`;

// ---------------------------------------------------------------------------
// `terminal_markers` — one row written when a run finishes (success OR
// terminal error). Resumer treats the presence of a row as "do not resume".
//
// Option 2 from the DURABLE.4 spec: explicit marker. Cheaper than Option 1
// (which would require the resumer to load every pack at scan time and
// compare `lastCompletedStep === totalSteps - 1`). One small insert per
// terminal outcome; sub-ms write cost.
// ---------------------------------------------------------------------------

const CREATE_TABLE_TERMINALS_SQL = `
  CREATE TABLE IF NOT EXISTS terminal_markers (
    run_id TEXT PRIMARY KEY,
    outcome TEXT NOT NULL,
    terminated_at_ms INTEGER NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// `task_checkpoints` — the durable per-TASK flow checkpoint (GS1). ADDITIVE:
// one row per task, keyed by the canonical work-graph issue id, recording the
// task's current FSM stage + the on-disk scope-proof artifacts. The v2 FSM's
// deterministic stage fn is the SINGLE WRITER (create-if-absent / update-stage
// / set-artifacts); the ralph loop's scope gate is a READER (+ a corrective
// stage reset). Deliberately its OWN table — NOT overloaded onto run_manifests
// (which records durable-execution RUNS, a different lifecycle) — so the two
// concerns never collide.
// ---------------------------------------------------------------------------

const CREATE_TABLE_TASK_CHECKPOINTS_SQL = `
  CREATE TABLE IF NOT EXISTS task_checkpoints (
    task_id TEXT PRIMARY KEY,
    stage TEXT NOT NULL,
    scope_artifacts_json TEXT NOT NULL DEFAULT '[]',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
`;

/** One row read back from `task_checkpoints` — the task's current stage + its recorded scope-proof paths. */
export interface TaskCheckpoint {
  stage: string;
  scopeArtifacts: string[];
}

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
    await this.db.execute(CREATE_TABLE_MANIFESTS_SQL);
    await this.db.execute(CREATE_INDEX_MANIFEST_STARTED_AT_SQL);
    await this.db.execute(CREATE_TABLE_TERMINALS_SQL);
    await this.db.execute(CREATE_TABLE_TASK_CHECKPOINTS_SQL);
    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // task_checkpoints — the durable per-task flow checkpoint (GS1).
  // -------------------------------------------------------------------------

  /**
   * CREATE-ONCE: insert the task's first checkpoint at `stage`. `ON CONFLICT DO NOTHING` makes a second call
   * for the same `taskId` a no-op — the row's `created_at_ms` + any recorded artifacts survive, and the stage
   * is only ever moved by {@link updateTaskStage}. Mirrors the `INSERT OR REPLACE` idempotency posture of
   * `append`/`recordRunStart`, but non-destructive (a re-create never clobbers an in-flight checkpoint).
   */
  async createTaskCheckpoint(taskId: string, stage: string, nowMs: number): Promise<void> {
    await this.init();
    await this.db.execute({
      sql: `INSERT INTO task_checkpoints (task_id, stage, scope_artifacts_json, created_at_ms, updated_at_ms)
            VALUES (?, ?, '[]', ?, ?)
            ON CONFLICT(task_id) DO NOTHING`,
      args: [taskId, stage, nowMs, nowMs],
    });
  }

  /**
   * UPDATE-ONLY: move an EXISTING task's stage (+ bump `updated_at_ms`). Never creates — a `WHERE task_id = ?`
   * that matches zero rows is a silent no-op (the caller that needs create semantics uses
   * {@link createTaskCheckpoint} first). This is what lets the loop's scope gate RESET a bogus checkpoint to
   * `scope` without resurrecting a checkpoint that was never created.
   */
  async updateTaskStage(taskId: string, stage: string, nowMs: number): Promise<void> {
    await this.init();
    await this.db.execute({
      sql: `UPDATE task_checkpoints SET stage = ?, updated_at_ms = ? WHERE task_id = ?`,
      args: [stage, nowMs, taskId],
    });
  }

  /**
   * UPDATE-ONLY: replace an EXISTING task's recorded scope-proof artifact paths (canonical JSON array).
   * Never creates (same 0-row no-op as {@link updateTaskStage}) — artifacts are only ever set on a task that
   * already has a checkpoint. The scope gate reads these back + verifies each path still exists on disk.
   */
  async setTaskArtifacts(taskId: string, files: string[], nowMs: number): Promise<void> {
    await this.init();
    await this.db.execute({
      sql: `UPDATE task_checkpoints SET scope_artifacts_json = ?, updated_at_ms = ? WHERE task_id = ?`,
      args: [JSON.stringify(files), nowMs, taskId],
    });
  }

  /** Read a task's checkpoint (stage + scope-proof paths), or `null` when the task has none. */
  async getTaskCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT stage, scope_artifacts_json FROM task_checkpoints WHERE task_id = ?`,
      args: [taskId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    let scopeArtifacts: string[] = [];
    try {
      const parsed = JSON.parse(String(row.scope_artifacts_json)) as unknown;
      if (Array.isArray(parsed)) scopeArtifacts = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      /* malformed json → treat as no recorded artifacts (the gate then holds until proof reappears) */
    }
    return { stage: String(row.stage), scopeArtifacts };
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

  /**
   * Record a run-start manifest. Called by the rule dispatcher BEFORE
   * `evaluateProcess` so that a crash mid-process leaves the manifest
   * behind for the Resumer (DURABLE.4) to find.
   *
   * `INSERT OR REPLACE` — idempotent on `runId`. A retried run with the
   * same identity overwrites the prior manifest (timestamps refresh,
   * event payload re-canonicalizes to the same JSON anyway). The Resumer
   * uses the latest manifest in any case.
   */
  async recordRunStart(manifest: RunManifest): Promise<void> {
    await this.init();
    const eventJson = canonicalJsonStringify(manifest.eventPayload);
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO run_manifests
              (run_id, pack_id, pack_version, skill, rule_id,
               event_kind, event_payload_json, started_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        manifest.runId,
        manifest.packId,
        manifest.packVersion,
        manifest.skill,
        manifest.ruleId,
        manifest.eventKind,
        eventJson,
        manifest.startedAtMs,
      ],
    });
  }

  /**
   * Look up the manifest for a runId. Returns `null` when the run was
   * never registered via `recordRunStart` — the Resumer treats those
   * runs as orphan checkpoints and skips them with audit reason
   * `manifest_missing`.
   */
  async getRunManifest(runId: string): Promise<RunManifest | null> {
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT run_id, pack_id, pack_version, skill, rule_id,
                   event_kind, event_payload_json, started_at_ms
            FROM run_manifests WHERE run_id = ?`,
      args: [runId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return rowToManifest(row);
  }

  /**
   * Record terminal outcome for a run. Called by the rule dispatcher
   * AFTER `evaluateProcess` returns (regardless of `verdict` / `no_verdict`
   * / `error`). The Resumer treats a row in `terminal_markers` as
   * "this run finished — do not resume".
   *
   * `outcome` is stored as free-form text for audit visibility
   * (verdict / no_verdict / error). The Resumer doesn't switch on it —
   * presence of the row is what gates resume.
   */
  async recordRunTerminal(runId: string, outcome: string, nowMs: number): Promise<void> {
    await this.init();
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO terminal_markers
              (run_id, outcome, terminated_at_ms)
            VALUES (?, ?, ?)`,
      args: [runId, outcome, nowMs],
    });
  }

  /**
   * Has the run terminated? `true` when a `terminal_markers` row exists
   * for the runId. Used by tests + the Resumer's own scan to short-circuit
   * cleanly without a second SELECT.
   */
  async hasTerminalMarker(runId: string): Promise<boolean> {
    await this.init();
    const rs = await this.db.execute({
      sql: `SELECT 1 FROM terminal_markers WHERE run_id = ? LIMIT 1`,
      args: [runId],
    });
    return rs.rows.length > 0;
  }

  /**
   * Scan for runs the Resumer (DURABLE.4) should consider resuming.
   *
   * A run is "interrupted" when:
   *   - It has at least one row in `checkpoints` (we ran something), AND
   *   - It has NO row in `terminal_markers` (process didn't finish), AND
   *   - The most-recent completed_at_ms is within `withinMs` of now
   *     (the resume window — older runs are "stale" and skipped by the
   *     Resumer with audit reason `stale`).
   *
   * Returns rows in ascending-age order (most recent first) so the
   * Resumer drains the freshest interrupted runs before stale ones in
   * pathological 100+-interrupted-runs cases.
   *
   * `withinMs <= 0` disables the window — useful for explicit
   * `opensquid checkpoints resume <run_id>` which bypasses the default.
   * The Resumer's own implementation passes `Number.POSITIVE_INFINITY`
   * for that path; this method clamps to a "no window" semantic when
   * the value is non-finite or non-positive.
   */
  async scanInterrupted(
    withinMs: number,
    nowMs: number = Date.now(),
  ): Promise<InterruptedSummary[]> {
    await this.init();
    const useWindow = Number.isFinite(withinMs) && withinMs > 0;
    const cutoff = useWindow ? nowMs - withinMs : 0;
    const sql = `
      SELECT c.run_id AS run_id,
             MAX(c.step_idx) AS last_step_idx,
             MAX(c.completed_at_ms) AS last_at_ms
      FROM checkpoints c
      LEFT JOIN terminal_markers t ON t.run_id = c.run_id
      WHERE t.run_id IS NULL
        ${useWindow ? 'AND c.completed_at_ms >= ?' : ''}
        AND c.status = 'completed'
      GROUP BY c.run_id
      ORDER BY last_at_ms DESC
    `;
    const args = useWindow ? [cutoff] : [];
    const rs = await this.db.execute({ sql, args });
    return rs.rows.map((row) => {
      const runIdRaw = row.run_id;
      return {
        runId: typeof runIdRaw === 'string' ? runIdRaw : '',
        lastCompletedStep: Number(row.last_step_idx),
        lastCompletedAtMs: Number(row.last_at_ms),
      };
    });
  }
}

/**
 * One row returned by `CheckpointStore.scanInterrupted` — the resumable
 * runs in the store. The Resumer joins this with `getRunManifest` to
 * build the full `InterruptedRun` shape (with packId / skill / ruleId /
 * eventPayload).
 */
export interface InterruptedSummary {
  runId: string;
  lastCompletedStep: number;
  lastCompletedAtMs: number;
}

/**
 * Map a libsql row to the typed `CheckpointRow`. `outputs_json` round-trips
 * through `canonicalJsonParse` so base64 envelopes restore as Buffers.
 */
function rowToManifest(row: Record<string, unknown>): RunManifest {
  const eventJson = row.event_payload_json;
  return {
    runId: String(row.run_id),
    packId: String(row.pack_id),
    packVersion: String(row.pack_version),
    skill: String(row.skill),
    ruleId: String(row.rule_id),
    eventKind: String(row.event_kind),
    eventPayload: typeof eventJson === 'string' ? canonicalJsonParse(eventJson) : null,
    startedAtMs: Number(row.started_at_ms),
  };
}

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

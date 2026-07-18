/**
 * LMP.1 + LMP.4 — the PUSH / LIVE-STREAM monitor feed's single source of truth.
 *
 * The loop monitor is a PUSH stream, not a pull: every state change appends ONE {@link MonitorEvent} to a
 * durable append-only `loop_events` log, and consumers TAIL / FOLD the log (they never re-derive from three
 * tables). This module owns that log (LMP.1 — the store + the raw cursor read) AND the consumer-side derivation
 * (LMP.4 — the pure fold into per-item latest state + the live subscribe primitive). Staleness is solved by the
 * pushed close event: `item_shipped`/`item_closed` fold to `terminal:true`, and the live view drops it — no
 * wg-status pull-join, no `loop_terminal_seen` linger table. Freshness is the push cadence itself: each item's
 * `lastEventAtMs` IS the "how long since it moved" signal (no separate heartbeat store/timer).
 *
 * Design of record: docs/design/opensquid-loop-monitoring-fix.md §6 (the eight CLOSED push/stream decisions).
 * The log's home is a NEW `loop_events` table in the project-local `opensquid.db` (via `withLoopDb`) — co-located
 * with `loop_phases`/`loop_metrics`/`task_checkpoints`; NOT `loop_metrics` (wrong per-stage-metrics grain,
 * loop_metrics.ts:13-14), NOT a flat file (SSOT §6.1), NOT `transitions.jsonl` (a separate subsystem).
 *
 * CORE carries NO stage vocabulary: `stage`/`phase` are OPAQUE strings stamped verbatim; only `kind`/`lifecycle`
 * are closed enums. Encoding a pack's phase names in core is the exact boundary leak loop_phase_store.ts:9-20
 * warns against.
 *
 * Imports from: @libsql/client, ./loop_db.js.
 * Imported by: ./monitor_emit.ts (the fail-open emit at the mutation), ./loop_state.ts (the fold consumer),
 *   src/cli/loop_status.ts (the --watch tail).
 */
import { createHash } from 'node:crypto';

import type { Client } from '@libsql/client';

import { dropLegacyFullstackLoopEventObjects } from '../../packs/migrations/fullstack_flow.js';
import { withLoopDb } from './loop_db.js';

/** The closed set of state-change kinds the feed pushes (core; a pack never adds one). */
export type MonitorEventKind =
  | 'stage_advance'
  | 'phase_enter'
  | 'phase_leave'
  | 'item_closed'
  | 'item_shipped'
  | 'item_wedged'
  | 'process_started'
  | 'process_shutdown_pending'
  | 'process_shutdown_requested'
  | 'process_terminate_requested'
  | 'process_force_kill_requested'
  | 'process_paused'
  | 'process_resumed'
  | 'process_exited'
  | 'process_spawn_failed'
  | 'process_control_requested'
  | 'process_control_applied'
  | 'process_control_failed';

/** The phase lifecycle marker — `running` on enter (⟳), `done` on leave (✓). Level-2; NO stage vocabulary. */
export type PhaseLifecycle = 'running' | 'done';

/** ONE pushed monitor event — the whole feed is a fold over these. `seq` is store-assigned (monotonic cursor). */
export interface MonitorEvent {
  seq: number;
  wgId: string;
  kind: MonitorEventKind;
  /** Set on `stage_advance` (opaque pack string; core assigns it no meaning). */
  stage?: string | undefined;
  /** Set on `phase_enter`/`phase_leave` (opaque pack string). */
  phase?: string | undefined;
  index?: number | undefined;
  total?: number | undefined;
  /** `running` on `phase_enter`, `done` on `phase_leave`. */
  lifecycle?: PhaseLifecycle | undefined;
  /** Owned-process control fields; absent on item stage/phase events. */
  processId?: string | undefined;
  /** Infrastructure cleanup topology only; never model authority. */
  ownership?: 'control_root' | 'owned' | undefined;
  /** One immutable OS-process incarnation under an attempt-local process id. */
  processInstanceId?: string | undefined;
  runId?: string | undefined;
  checkpointStage?: string | undefined;
  lap?: number | undefined;
  role?: string | undefined;
  pid?: number | undefined;
  processGroupId?: number | undefined;
  processStartIdentity?: string | undefined;
  windowsJobName?: string | undefined;
  windowsJobMetadata?: string | undefined;
  exitCode?: number | null | undefined;
  requestedBy?: 'cli' | 'tui' | 'web' | undefined;
  /** Human authorization and action audit fields; absent from automatic lifecycle events. */
  authorizedBy?: string | undefined;
  actionId?: string | undefined;
  /** Immutable interactive-scope approval evidence; absent from every non-handoff event. */
  scopeArtifactPath?: string | undefined;
  scopeArtifactSha256?: string | undefined;
  scopeEvidenceKind?: 'approval' | 'legacy_repair' | undefined;
  controlAction?: 'graceful_stop' | 'terminate' | 'force_kill' | 'resume' | undefined;
  requestedAtMs?: number | undefined;
  appliedAtMs?: number | undefined;
  failedAtMs?: number | undefined;
  failure?: string | undefined;
  atMs: number;
}

/** The append input — the store assigns `seq` (a caller never supplies it). */
export type NewMonitorEvent = Omit<MonitorEvent, 'seq'>;

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS loop_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,   -- strictly increasing, gap-safe cursor (exactly-once tail)
    wg_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    stage TEXT,
    phase TEXT,
    phase_index INTEGER,
    phase_total INTEGER,
    lifecycle TEXT,
    process_id TEXT,
    ownership TEXT,
    process_instance_id TEXT,
    run_id TEXT,
    checkpoint_stage TEXT,
    lap INTEGER,
    role TEXT,
    pid INTEGER,
    process_group_id INTEGER,
    process_start_identity TEXT,
    windows_job_name TEXT,
    windows_job_metadata TEXT,
    exit_code INTEGER,
    requested_by TEXT,
    authorized_by TEXT,
    action_id TEXT,
    scope_artifact_path TEXT,
    scope_artifact_sha256 TEXT,
    scope_evidence_kind TEXT,
    control_action TEXT,
    requested_at_ms INTEGER,
    applied_at_ms INTEGER,
    failed_at_ms INTEGER,
    failure TEXT,
    at_ms INTEGER NOT NULL
  );
`;
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_loop_events_wg ON loop_events(wg_id);`;

/** Exact v1 receipt predicate. Keep byte-identical in DDL and bounded receipt queries. */
export const SCOPE_HANDOFF_RECEIPT_PREDICATE =
  "kind='stage_advance' AND action_id IS NOT NULL AND length(action_id)=81 " +
  "AND substr(action_id,1,17)='scope-handoff:v1:' " +
  "AND substr(action_id,18) NOT GLOB '*[^0-9a-f]*'";

const CREATE_SCOPE_ACTION_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_events_scope_handoff_action ON loop_events(action_id) ` +
  `WHERE ${SCOPE_HANDOFF_RECEIPT_PREDICATE}`;
const CREATE_SCOPE_ITEM_INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_loop_events_scope_handoff_item ON loop_events(wg_id) ` +
  `WHERE ${SCOPE_HANDOFF_RECEIPT_PREDICATE}`;
const CREATE_SCOPE_LEGACY_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_loop_events_automation_entry_legacy ` +
  `ON loop_events(wg_id, stage, seq DESC) WHERE kind='stage_advance' AND action_id IS NULL`;

const VALID_NEW_SCOPE_RECEIPT_SQL =
  "NEW.kind='stage_advance' AND NEW.stage IS NOT NULL AND length(NEW.stage)>0 " +
  'AND NEW.action_id IS NOT NULL AND length(NEW.action_id)=81 ' +
  "AND substr(NEW.action_id,1,17)='scope-handoff:v1:' " +
  "AND substr(NEW.action_id,18) NOT GLOB '*[^0-9a-f]*' " +
  'AND NEW.scope_artifact_path IS NOT NULL AND length(NEW.scope_artifact_path)>0 ' +
  'AND NEW.scope_artifact_sha256 IS NOT NULL AND length(NEW.scope_artifact_sha256)=64 ' +
  "AND NEW.scope_artifact_sha256 NOT GLOB '*[^0-9a-f]*' " +
  "AND NEW.scope_evidence_kind IN ('approval','legacy_repair')";
const CREATE_SCOPE_INSERT_GUARD_SQL =
  `CREATE TRIGGER IF NOT EXISTS trg_loop_events_scope_handoff_insert ` +
  `BEFORE INSERT ON loop_events WHEN NEW.action_id LIKE 'scope-handoff:%' ` +
  `AND NOT (${VALID_NEW_SCOPE_RECEIPT_SQL}) BEGIN ` +
  `SELECT RAISE(ABORT, 'invalid scope-handoff receipt'); END`;
const CREATE_SCOPE_UPDATE_GUARD_SQL =
  `CREATE TRIGGER IF NOT EXISTS trg_loop_events_scope_handoff_update ` +
  `BEFORE UPDATE ON loop_events WHEN OLD.action_id LIKE 'scope-handoff:%' ` +
  `OR NEW.action_id LIKE 'scope-handoff:%' BEGIN ` +
  `SELECT RAISE(ABORT, 'scope-handoff receipts are immutable'); END`;
const CREATE_SCOPE_DELETE_GUARD_SQL =
  `CREATE TRIGGER IF NOT EXISTS trg_loop_events_scope_handoff_delete ` +
  `BEFORE DELETE ON loop_events WHEN OLD.action_id LIKE 'scope-handoff:%' BEGIN ` +
  `SELECT RAISE(ABORT, 'scope-handoff receipts are immutable'); END`;

/**
 * §C.13 DDL HOIST — the `CREATE TABLE/INDEX IF NOT EXISTS` ran on EVERY append + EVERY tail (two round-trips per
 * op). It is idempotent, so re-running it is pure waste. Memoize it as a once-per-store promise keyed by the
 * resolved store URL: the first append/tail against a store executes the DDL, every later op reuses the settled
 * promise (O(1), no round-trip). Keyed by URL — not a bare boolean — so the per-test `OPENSQUID_PROJECT_ROOT`
 * override (a fresh DB file per test) still gets its own DDL; a REJECTED guard is evicted so the next op retries.
 */
const ddlByUrl = new Map<string, Promise<void>>();

export function ensureLoopEventSchema(db: Client, url: string): Promise<void> {
  let guard = ddlByUrl.get(url);
  if (guard === undefined) {
    guard = (async () => {
      await db.execute(CREATE_TABLE_SQL);
      const info = await db.execute('PRAGMA table_info(loop_events)');
      const existing = new Set(
        info.rows.map((row) => (typeof row.name === 'string' ? row.name : '')),
      );
      const additions = [
        ['process_id', 'TEXT'],
        ['ownership', 'TEXT'],
        ['process_instance_id', 'TEXT'],
        ['run_id', 'TEXT'],
        ['checkpoint_stage', 'TEXT'],
        ['lap', 'INTEGER'],
        ['role', 'TEXT'],
        ['pid', 'INTEGER'],
        ['process_group_id', 'INTEGER'],
        ['process_start_identity', 'TEXT'],
        ['windows_job_name', 'TEXT'],
        ['windows_job_metadata', 'TEXT'],
        ['exit_code', 'INTEGER'],
        ['requested_by', 'TEXT'],
        ['authorized_by', 'TEXT'],
        ['action_id', 'TEXT'],
        ['scope_artifact_path', 'TEXT'],
        ['scope_artifact_sha256', 'TEXT'],
        ['scope_evidence_kind', 'TEXT'],
        ['control_action', 'TEXT'],
        ['requested_at_ms', 'INTEGER'],
        ['applied_at_ms', 'INTEGER'],
        ['failed_at_ms', 'INTEGER'],
        ['failure', 'TEXT'],
      ] as const;
      for (const [name, type] of additions) {
        if (existing.has(name)) continue;
        try {
          await db.execute(`ALTER TABLE loop_events ADD COLUMN ${name} ${type}`);
        } catch (error) {
          // A second process may have added the same column after our PRAGMA read.
          if (!(error instanceof Error) || !error.message.includes('duplicate column name'))
            throw error;
        }
      }
      // Existing namespaced rows must be valid before uniqueness becomes authoritative. Additive nullable columns
      // are harmless on a failed migration; history is never deleted or rewritten.
      const receipts = await db.execute(
        `SELECT wg_id, kind, stage, action_id, scope_artifact_path, scope_artifact_sha256, scope_evidence_kind
         FROM loop_events WHERE action_id LIKE 'scope-handoff:%'`,
      );
      const actionIds = new Set<string>();
      const itemIds = new Set<string>();
      for (const row of receipts.rows) {
        const actionId = asOptStr(row.action_id);
        const wgId = asOptStr(row.wg_id);
        const artifact = asOptStr(row.scope_artifact_path);
        const digest = asOptStr(row.scope_artifact_sha256);
        const evidence = asOptStr(row.scope_evidence_kind);
        const valid =
          row.kind === 'stage_advance' &&
          typeof row.stage === 'string' &&
          actionId !== undefined &&
          wgId !== undefined &&
          artifact !== undefined &&
          digest !== undefined &&
          evidence !== undefined &&
          isSemanticScopeReceipt({
            wgId,
            actionId,
            stage: row.stage,
            artifactPath: artifact,
            artifactSha256: digest,
            evidenceKind: evidence,
          });
        if (!valid) throw new Error('loop_events: malformed existing scope-handoff:v1 receipt');
        if (actionIds.has(actionId) || itemIds.has(wgId)) {
          throw new Error('loop_events: duplicate existing scope-handoff:v1 receipt');
        }
        actionIds.add(actionId);
        itemIds.add(wgId);
      }
      await db.execute(CREATE_INDEX_SQL);
      // Replace earlier stage-vocabulary DDL with the opaque-stage receipt invariant.
      await db.execute('DROP TRIGGER IF EXISTS trg_loop_events_scope_handoff_insert');
      await dropLegacyFullstackLoopEventObjects(db);
      await db.execute(CREATE_SCOPE_ACTION_INDEX_SQL);
      await db.execute(CREATE_SCOPE_ITEM_INDEX_SQL);
      await db.execute(CREATE_SCOPE_LEGACY_INDEX_SQL);
      await db.execute(CREATE_SCOPE_INSERT_GUARD_SQL);
      await db.execute(CREATE_SCOPE_UPDATE_GUARD_SQL);
      await db.execute(CREATE_SCOPE_DELETE_GUARD_SQL);
    })().catch((e: unknown) => {
      ddlByUrl.delete(url); // a transient DDL failure must not pin a rejected guard — the next op retries
      throw e;
    });
    ddlByUrl.set(url, guard);
  }
  return guard;
}

/** Coerce a stored `lifecycle` cell to the closed enum (unknown/absent → `running`). */
function coerceLifecycle(cell: unknown): PhaseLifecycle | undefined {
  if (cell === null || cell === undefined) return undefined;
  return cell === 'done' ? 'done' : 'running';
}

/** Read a nullable TEXT cell as a string (a non-string/NULL cell → `undefined`) — avoids `String()` on `unknown`. */
function asOptStr(cell: unknown): string | undefined {
  return typeof cell === 'string' ? cell : undefined;
}

export type LoopEventExecutor = Pick<Client, 'execute'>;

/** One canonical receipt identity implementation, reused by entry, migration, insertion, and decode. */
export function scopeHandoffActionId(wgId: string, artifactPath: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([wgId, artifactPath]), 'utf8')
    .digest('hex');
  return `scope-handoff:v1:${hash}`;
}

function isSemanticScopeReceipt(value: {
  wgId: string;
  actionId: string;
  stage: string;
  artifactPath: string;
  artifactSha256: string;
  evidenceKind: string;
}): boolean {
  return (
    value.actionId === scopeHandoffActionId(value.wgId, value.artifactPath) &&
    value.stage.length > 0 &&
    /^[0-9a-f]{64}$/u.test(value.artifactSha256) &&
    (value.evidenceKind === 'approval' || value.evidenceKind === 'legacy_repair')
  );
}

export interface ScopeHandoffReceipt {
  readonly seq: number;
  readonly wgId: string;
  readonly actionId: string;
  readonly stage: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly evidenceKind: 'approval' | 'legacy_repair';
}

function decodeScopeHandoffReceipt(row: Record<string, unknown>): ScopeHandoffReceipt {
  const actionId = asOptStr(row.action_id);
  const wgId = asOptStr(row.wg_id);
  const stage = asOptStr(row.stage);
  const artifactPath = asOptStr(row.scope_artifact_path);
  const artifactSha256 = asOptStr(row.scope_artifact_sha256);
  const evidenceKind = asOptStr(row.scope_evidence_kind);
  if (
    actionId === undefined ||
    wgId === undefined ||
    stage === undefined ||
    artifactPath === undefined ||
    artifactSha256 === undefined ||
    (evidenceKind !== 'approval' && evidenceKind !== 'legacy_repair') ||
    !isSemanticScopeReceipt({
      wgId,
      actionId,
      stage,
      artifactPath,
      artifactSha256,
      evidenceKind,
    })
  ) {
    throw new Error('loop_events: malformed scope handoff receipt');
  }
  return {
    seq: Number(row.seq),
    wgId,
    actionId,
    stage,
    artifactPath,
    artifactSha256,
    evidenceKind,
  };
}

const SCOPE_RECEIPT_COLUMNS =
  'seq,wg_id,action_id,stage,scope_artifact_path,scope_artifact_sha256,scope_evidence_kind';

/** Bounded, index-forced lookup of the one keyed receipt owned by an item. */
export async function readScopeHandoffByItem(
  db: LoopEventExecutor,
  wgId: string,
): Promise<ScopeHandoffReceipt | null> {
  const rs = await db.execute({
    sql:
      `SELECT ${SCOPE_RECEIPT_COLUMNS} FROM loop_events INDEXED BY idx_loop_events_scope_handoff_item ` +
      `WHERE wg_id=? AND ${SCOPE_HANDOFF_RECEIPT_PREDICATE} ORDER BY seq DESC LIMIT 2`,
    args: [wgId],
  });
  if (rs.rows.length > 1)
    throw new Error(`loop_events: duplicate scope handoff receipts for ${wgId}`);
  return rs.rows[0] === undefined ? null : decodeScopeHandoffReceipt(rs.rows[0]);
}

/** Bounded collision lookup for the deterministic action identity. */
export async function readScopeHandoffByAction(
  db: LoopEventExecutor,
  actionId: string,
): Promise<ScopeHandoffReceipt | null> {
  const rs = await db.execute({
    sql:
      `SELECT ${SCOPE_RECEIPT_COLUMNS} FROM loop_events INDEXED BY idx_loop_events_scope_handoff_action ` +
      `WHERE action_id=? AND ${SCOPE_HANDOFF_RECEIPT_PREDICATE} LIMIT 2`,
    args: [actionId],
  });
  if (rs.rows.length > 1)
    throw new Error(`loop_events: duplicate scope handoff action ${actionId}`);
  return rs.rows[0] === undefined ? null : decodeScopeHandoffReceipt(rs.rows[0]);
}

/** Read at most two unkeyed pre-fix transitions for the pack-declared automation entry. */
export async function readLegacyAutomationEntrySeqs(
  db: LoopEventExecutor,
  wgId: string,
  entryStage: string,
): Promise<number[]> {
  const rs = await db.execute({
    sql:
      `SELECT seq FROM loop_events INDEXED BY idx_loop_events_automation_entry_legacy ` +
      `WHERE wg_id=? AND kind='stage_advance' AND stage=? AND action_id IS NULL ` +
      `ORDER BY seq DESC LIMIT 2`,
    args: [wgId, entryStage],
  });
  return rs.rows.map((row) => Number(row.seq));
}

export async function insertScopeHandoffReceipt(
  db: LoopEventExecutor,
  receipt: Omit<ScopeHandoffReceipt, 'seq'> & { atMs: number },
): Promise<void> {
  if (
    !isSemanticScopeReceipt({
      wgId: receipt.wgId,
      actionId: receipt.actionId,
      stage: receipt.stage,
      artifactPath: receipt.artifactPath,
      artifactSha256: receipt.artifactSha256,
      evidenceKind: receipt.evidenceKind,
    })
  ) {
    throw new Error('loop_events: invalid scope handoff receipt');
  }
  await db.execute({
    sql: `INSERT INTO loop_events
            (wg_id,kind,stage,action_id,scope_artifact_path,scope_artifact_sha256,scope_evidence_kind,at_ms)
          VALUES (?,'stage_advance',?,?,?,?,?,?)`,
    args: [
      receipt.wgId,
      receipt.stage,
      receipt.actionId,
      receipt.artifactPath,
      receipt.artifactSha256,
      receipt.evidenceKind,
      receipt.atMs,
    ],
  });
}

/**
 * Append one event (fail-CLOSED at this layer — it may throw). The FAIL-OPEN wrapping at the mutation is LMP.2's
 * `emitMonitorEvent`; keeping the store fail-closed and the mutation wrapper fail-open keeps the store testable
 * and the mutation safe. The store assigns `seq` (the input omits it), mirroring `AuditLog.append`.
 */
export async function appendMonitorEvent(ev: NewMonitorEvent): Promise<void> {
  if (ev.actionId?.startsWith('scope-handoff:') === true) {
    throw new Error('loop_events: scope-handoff action ids require the dedicated receipt writer');
  }
  await withLoopDb(async (db, url) => {
    await ensureLoopEventSchema(db, url);
    await db.execute({
      sql: `INSERT INTO loop_events
              (wg_id, kind, stage, phase, phase_index, phase_total, lifecycle,
               process_id, ownership, process_instance_id, run_id, checkpoint_stage, lap, role, pid,
               process_group_id, process_start_identity, windows_job_name, windows_job_metadata, exit_code,
               requested_by, authorized_by, action_id, scope_artifact_path, scope_artifact_sha256,
               scope_evidence_kind, control_action, requested_at_ms, applied_at_ms, failed_at_ms, failure, at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ev.wgId,
        ev.kind,
        ev.stage ?? null,
        ev.phase ?? null,
        ev.index ?? null,
        ev.total ?? null,
        ev.lifecycle ?? null,
        ev.processId ?? null,
        ev.ownership ?? null,
        ev.processInstanceId ?? null,
        ev.runId ?? null,
        ev.checkpointStage ?? null,
        ev.lap ?? null,
        ev.role ?? null,
        ev.pid ?? null,
        ev.processGroupId ?? null,
        ev.processStartIdentity ?? null,
        ev.windowsJobName ?? null,
        ev.windowsJobMetadata ?? null,
        ev.exitCode ?? null,
        ev.requestedBy ?? null,
        ev.authorizedBy ?? null,
        ev.actionId ?? null,
        ev.scopeArtifactPath ?? null,
        ev.scopeArtifactSha256 ?? null,
        ev.scopeEvidenceKind ?? null,
        ev.controlAction ?? null,
        ev.requestedAtMs ?? null,
        ev.appliedAtMs ?? null,
        ev.failedAtMs ?? null,
        ev.failure ?? null,
        ev.atMs,
      ],
    });
  });
}

/**
 * The raw cursor read — every event with `seq > sinceSeq`, in ascending `seq` order (`seq` included), so a
 * consumer resuming from a cursor sees every event exactly once, in order (exactly-once resume, gap-safe).
 */
export async function tailEventsSince(sinceSeq: number): Promise<MonitorEvent[]> {
  return withLoopDb(async (db, url) => {
    await ensureLoopEventSchema(db, url);
    const rs = await db.execute({
      sql: `SELECT seq, wg_id, kind, stage, phase, phase_index, phase_total, lifecycle,
                   process_id, ownership, process_instance_id, run_id, checkpoint_stage, lap, role, pid,
                   process_group_id, process_start_identity, windows_job_name, windows_job_metadata, exit_code,
                   requested_by, authorized_by, action_id, scope_artifact_path, scope_artifact_sha256,
                   scope_evidence_kind, control_action, requested_at_ms, applied_at_ms, failed_at_ms, failure, at_ms
            FROM loop_events WHERE seq > ? ORDER BY seq ASC`,
      args: [sinceSeq],
    });
    return rs.rows.map((r) => ({
      seq: Number(r.seq),
      wgId: typeof r.wg_id === 'string' ? r.wg_id : '',
      kind: (asOptStr(r.kind) ?? '') as MonitorEventKind,
      stage: asOptStr(r.stage),
      phase: asOptStr(r.phase),
      index: r.phase_index === null ? undefined : Number(r.phase_index),
      total: r.phase_total === null ? undefined : Number(r.phase_total),
      lifecycle: coerceLifecycle(r.lifecycle),
      processId: asOptStr(r.process_id),
      ownership:
        r.ownership === 'control_root' || r.ownership === 'owned' ? r.ownership : undefined,
      processInstanceId: asOptStr(r.process_instance_id),
      runId: asOptStr(r.run_id),
      checkpointStage: asOptStr(r.checkpoint_stage),
      lap: r.lap === null ? undefined : Number(r.lap),
      role: asOptStr(r.role),
      pid: r.pid === null ? undefined : Number(r.pid),
      processGroupId: r.process_group_id === null ? undefined : Number(r.process_group_id),
      processStartIdentity: asOptStr(r.process_start_identity),
      windowsJobName: asOptStr(r.windows_job_name),
      windowsJobMetadata: asOptStr(r.windows_job_metadata),
      exitCode: r.exit_code === null ? undefined : Number(r.exit_code),
      requestedBy:
        r.requested_by === 'cli' || r.requested_by === 'tui' || r.requested_by === 'web'
          ? r.requested_by
          : undefined,
      authorizedBy: asOptStr(r.authorized_by),
      actionId: asOptStr(r.action_id),
      scopeArtifactPath: asOptStr(r.scope_artifact_path),
      scopeArtifactSha256: asOptStr(r.scope_artifact_sha256),
      scopeEvidenceKind:
        r.scope_evidence_kind === 'approval' || r.scope_evidence_kind === 'legacy_repair'
          ? r.scope_evidence_kind
          : undefined,
      controlAction:
        r.control_action === 'graceful_stop' ||
        r.control_action === 'terminate' ||
        r.control_action === 'force_kill' ||
        r.control_action === 'resume'
          ? r.control_action
          : undefined,
      requestedAtMs: r.requested_at_ms === null ? undefined : Number(r.requested_at_ms),
      appliedAtMs: r.applied_at_ms === null ? undefined : Number(r.applied_at_ms),
      failedAtMs: r.failed_at_ms === null ? undefined : Number(r.failed_at_ms),
      failure: asOptStr(r.failure),
      atMs: Number(r.at_ms),
    }));
  });
}

// ---------------------------------------------------------------------------
// LMP.4 — the consumer API: the pure fold (materialized latest-state) + the live subscribe primitive.
// ---------------------------------------------------------------------------

/** ONE item's current state, folded from the ordered event log. `terminal` carries the staleness drop. */
export interface LoopFoldState {
  wgId: string;
  stage?: string | undefined;
  phase?: string | undefined;
  index?: number | undefined;
  total?: number | undefined;
  lifecycle?: PhaseLifecycle | undefined;
  /** The push-cadence freshness signal (decision 5 — NO separate heartbeat store/timer). */
  lastEventAtMs: number;
  /** Latest event was `item_closed`/`item_shipped` → the live view drops it (the staleness fix, decision 2). */
  terminal: boolean;
}

/**
 * PURE, deterministic reducer — fold an ORDERED (seq-ascending) event slice into per-item latest state. Folding
 * the SAME events in `seq` order is chunk-invariant (a consumer resuming mid-stream and one folding the whole
 * log reach the same state — pre-research risk §7). `stage_advance` CLEARS the phase (a new stage has no phase
 * yet); `phase_enter`/`phase_leave` set the phase + lifecycle; `item_shipped`/`item_closed` mark terminal;
 * `item_wedged` leaves the item visible (parked awaiting the human — the feed does not re-derive the reason).
 */
export function foldEvents(events: MonitorEvent[]): LoopFoldState[] {
  const byWg = new Map<string, LoopFoldState>();
  for (const e of events) applyMonitorEvent(byWg, e);
  return [...byWg.values()];
}

/**
 * Apply ONE event to a per-item fold map in place (the reducer step shared by the whole-log {@link foldEvents}
 * and the incremental {@link foldLatestStateIncremental} — folding is folding, one rule). PURE w.r.t. the DB
 * (mutates only the passed map). Kept module-private: the two fold entry points are the API.
 */
function applyMonitorEvent(byWg: Map<string, LoopFoldState>, e: MonitorEvent): void {
  if (e.kind.startsWith('process_')) {
    // Owned-process details have their own fold, but their lifecycle is still real item activity. Refresh an already
    // staged item's age without inventing a stage/phase or creating readiness-probe-only items in the item view.
    const activeItem = byWg.get(e.wgId);
    if (activeItem !== undefined) activeItem.lastEventAtMs = e.atMs;
    return;
  }
  const s = byWg.get(e.wgId) ?? { wgId: e.wgId, lastEventAtMs: e.atMs, terminal: false };
  s.lastEventAtMs = e.atMs;
  switch (e.kind) {
    case 'stage_advance':
      s.stage = e.stage;
      s.phase = undefined;
      s.index = undefined;
      s.total = undefined;
      s.lifecycle = undefined;
      // F1b — terminal is ABSORBING: once closed/shipped, a later stray stage_advance does NOT resurrect the item
      // (the non-atomic close/emit window + a stage_advance emitted for an already-closed item both used to
      // clear terminal here, so a closed item re-appeared on the feed). Closed-ness has ONE writer (wg status,
      // §9); the feed only re-opens an item via an explicit event the design does not emit, so `terminal` stays.
      break;
    case 'phase_enter':
      s.phase = e.phase;
      s.index = e.index;
      s.total = e.total;
      s.lifecycle = 'running';
      break;
    case 'phase_leave':
      s.phase = e.phase;
      s.index = e.index;
      s.total = e.total;
      s.lifecycle = 'done';
      break;
    case 'item_shipped':
    case 'item_closed':
      s.terminal = true;
      break;
    case 'item_wedged':
      break; // parked, still shown (the feed does not re-derive the reason — §5 OUT)
    case 'process_started':
    case 'process_shutdown_pending':
    case 'process_shutdown_requested':
    case 'process_terminate_requested':
    case 'process_force_kill_requested':
    case 'process_paused':
    case 'process_resumed':
    case 'process_exited':
    case 'process_spawn_failed':
    case 'process_control_requested':
    case 'process_control_applied':
    case 'process_control_failed':
      return; // narrowed above; retained for exhaustive checking
  }
  byWg.set(e.wgId, s);
}

/**
 * The FULL-truth materialization (terminal items INCLUDED, marked `terminal:true`) — the old `collectLoopState`
 * all-items contract, so `--json`/the UI still see everything. The live-view DROP of terminal items is a
 * consumer filter (LMP.5's `liveItems`), never a fold omission (or `--json` loses truth).
 */
export async function foldLatestState(): Promise<LoopFoldState[]> {
  return foldEvents(await tailEventsSince(0));
}

// ---------------------------------------------------------------------------
// §C.12 SCALABILITY — the INCREMENTALLY-materialized projection for the write path.
//
// `foldLatestState` re-reads the ENTIRE append-only log (`tailEventsSince(0)`) and re-folds it — fine on-demand
// (a CLI invocation, a watcher's ONE initial fold), but ruinous if run on the emit path: `emitMonitorEvent` fires
// on every state change, the log grows by one per emit and never prunes, so a full re-fold per emit is O(N) work
// that grows with history → O(N²) over a project's life. The snapshot writer (SLC.2) needs the current board on
// every emit, so it uses THIS instead: a module-level materialized fold advanced by a cursor — the first read in a
// process folds from seq 0 once (O(N)), every subsequent read tails only the NEW events (O(1) amortized), the same
// cursor discipline `subscribeMonitor` uses so a consumer adds NO per-emit full scan (design §6.3, scalability).
//
// The DB log stays the SSOT; this cache is a pure derivation (no writes), rebuilt from 0 on process restart.
// Concurrent refreshes are serialized through a promise chain so the read-modify-write of the shared map + cursor
// never interleaves (no double-apply). A tail fault leaves the cursor unadvanced (nothing is applied before the
// awaited read) → the next call retries; the fault surfaces to THIS caller (the fail-open snapshot writer swallows
// it) while the chain stays alive for the next refresh.
// ---------------------------------------------------------------------------

let projectionCursor = 0;
const projectionState = new Map<string, LoopFoldState>();
let projectionChain: Promise<void> = Promise.resolve();

/**
 * The current board, folded INCREMENTALLY from the cursor (the emit-path read — bounds per-emit work to the NEW
 * events, never a whole-log re-scan). Same result as {@link foldLatestState} (deterministic, chunk-invariant
 * fold), just materialized across calls within a process.
 */
export async function foldLatestStateIncremental(): Promise<LoopFoldState[]> {
  const step = projectionChain.then(async () => {
    const batch = await tailEventsSince(projectionCursor);
    for (const e of batch) applyMonitorEvent(projectionState, e);
    if (batch.length > 0) projectionCursor = batch[batch.length - 1]!.seq;
  });
  // Keep the serialization chain alive even if this step rejects; the rejection is re-thrown to the caller below.
  projectionChain = step.catch(() => undefined);
  await step;
  return [...projectionState.values()];
}

/** TEST SEAM — reset the process-local projection so a test starts from an empty, cold materialization. */
export function resetLoopStateProjectionForTest(): void {
  projectionCursor = 0;
  projectionState.clear();
  projectionChain = Promise.resolve();
  ddlByUrl.clear(); // also drop the once-per-store DDL guard so a fresh test store re-creates its table
}

/**
 * The live cursor loop — tail past `sinceSeq`, invoke `onEvent` for each NEW event as it lands (in `seq` order),
 * advance the cursor past the max `seq`, repeat. The primitive `--watch`/Monitor tail (LMP.5 wires it): a new
 * consumer subscribes with ZERO write-path change (scalability §6.3). The poll interval is a fallback cadence,
 * not the freshness mechanism; the cursor advance is exactly-once (never re-emits an event).
 */
export async function subscribeMonitor(
  sinceSeq: number,
  onEvent: (e: MonitorEvent) => void,
  opts: { intervalMs?: number; shouldStop?: () => boolean } = {},
): Promise<void> {
  let cursor = sinceSeq;
  const interval = opts.intervalMs ?? 1000;
  while (!(opts.shouldStop?.() ?? false)) {
    const batch = await tailEventsSince(cursor);
    for (const e of batch) {
      onEvent(e);
      cursor = e.seq;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

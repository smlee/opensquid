import { randomUUID } from 'node:crypto';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import type { Client } from '@libsql/client';

import { loopDbUrl, withLoopDb } from '../loop/loop_db.js';
import {
  appendMonitorEvent,
  tailEventsSince,
  type MonitorEvent,
  type MonitorEventKind,
} from '../loop/loop_events.js';
import { realProcControl, type ProcControl } from '../spawn_lifecycle.js';
import {
  controlWindowsJob,
  createWindowsJobIdentity,
  spawnInWindowsJob,
  type WindowsJobIdentity,
} from './windows_job.js';

export type ExecutorProcessStatus =
  | 'running'
  | 'shutdown_pending'
  | 'shutdown_requested'
  | 'terminate_requested'
  | 'force_kill_requested'
  | 'paused'
  | 'resumed'
  | 'exited'
  | 'spawn_failed';

export type HumanExecutorAction = 'graceful_stop' | 'terminate' | 'force_kill' | 'resume';
export type HumanProcessSignalAction = Exclude<HumanExecutorAction, 'resume'>;
export type HumanControlSurface = 'cli' | 'tui' | 'web';

export type ProcessShutdownCause =
  | { readonly kind: 'automatic' }
  | {
      readonly kind: 'human';
      readonly action: HumanProcessSignalAction;
      readonly requestedBy: HumanControlSurface;
      readonly authorizedBy: string;
      readonly actionId: string;
    };

export class ProcessPausedError extends Error {
  readonly code = 'OPENSQUID_PROCESS_PAUSED';

  constructor(
    readonly executorId: string,
    readonly cause: Extract<ProcessShutdownCause, { kind: 'human' }>,
    message = `process ${executorId} is paused pending control-plane resolution`,
  ) {
    super(message);
    this.name = 'ProcessPausedError';
  }
}

export function isProcessPausedError(value: unknown): value is ProcessPausedError {
  return (
    value instanceof ProcessPausedError ||
    (value instanceof Error && (value as { code?: unknown }).code === 'OPENSQUID_PROCESS_PAUSED')
  );
}

export interface ExecutorActionAudit {
  readonly actionId: string;
  readonly action: HumanExecutorAction;
  readonly requestedBy: HumanControlSurface;
  readonly authorizedBy: string;
  readonly requestedAtMs: number;
  readonly appliedAtMs?: number;
  readonly failedAtMs?: number;
  readonly failure?: string;
}

export interface ExecutorProcessState {
  /** Stable logical identity across fresh laps. */
  readonly executorId: string;
  /** Immutable identity of this current OS-process incarnation. */
  readonly processInstanceId: string;
  readonly actor: 'parent' | 'executor';
  readonly wgId: string;
  readonly runId?: string;
  readonly checkpointStage?: string;
  readonly lap?: number;
  readonly role: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly processStartIdentity: string;
  readonly windowsJobName?: string;
  readonly windowsJobMetadata?: string;
  readonly status: ExecutorProcessStatus;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly exitCode?: number | null;
  readonly latestAction?: ExecutorActionAudit;
  readonly availableActions: readonly HumanExecutorAction[];
}

export interface ExecutorControlRequest {
  readonly seq: number;
  readonly actionId: string;
  readonly executorId: string;
  readonly processInstanceId: string;
  readonly wgId: string;
  readonly action: HumanProcessSignalAction;
  readonly requestedBy: HumanControlSurface;
  readonly authorizedBy: string;
  readonly requestedAtMs: number;
  readonly targetPid: number;
  readonly targetProcessGroupId: number;
  readonly targetProcessStartIdentity: string;
}

export interface ExecutorControlReceipt extends ExecutorControlRequest {
  readonly result: 'queued' | 'applied' | 'failed';
  readonly appliedAtMs?: number;
  readonly failedAtMs?: number;
  readonly failure?: string;
  /** Human-authorized cascade receipts when a parent action covers active executors in the same run. */
  readonly related?: readonly ExecutorControlReceipt[];
}

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  readonly processGroupId: number;
  readonly startIdentity: string;
}

export async function readProcessIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`invalid owned process pid: ${String(pid)}`);
  if (process.platform === 'win32') {
    const script =
      `$p=Get-Process -Id ${String(pid)} -ErrorAction Stop;` +
      '[Console]::Out.Write("{0}|{1}",$p.Id,$p.StartTime.ToUniversalTime().Ticks)';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script]);
    const [actualPid, ticks] = stdout.trim().split('|');
    if (Number(actualPid) !== pid || ticks === undefined || ticks === '') {
      throw new Error(`could not validate owned Windows process ${String(pid)}`);
    }
    return { processGroupId: pid, startIdentity: ticks };
  }
  const { stdout } = await execFileAsync('ps', [
    '-o',
    'pid=',
    '-o',
    'pgid=',
    '-o',
    'lstart=',
    '-p',
    String(pid),
  ]);
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(stdout);
  if (match === null || Number(match[1]) !== pid) {
    throw new Error(`could not validate owned process ${String(pid)}`);
  }
  return { processGroupId: Number(match[2]), startIdentity: match[3]! };
}

const ACTIVE_STATUSES = new Set<ExecutorProcessStatus>([
  'running',
  'shutdown_pending',
  'shutdown_requested',
  'terminate_requested',
  'force_kill_requested',
]);

const ddlByUrl = new Map<string, Promise<void>>();

async function addMissingColumns(
  db: Client,
  table: string,
  additions: readonly (readonly [string, string])[],
): Promise<void> {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  const existing = new Set(info.rows.map((row) => (typeof row.name === 'string' ? row.name : '')));
  for (const [name, type] of additions) {
    if (existing.has(name)) continue;
    try {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('duplicate column name'))
        throw error;
    }
  }
}

function ensureTables(db: Client, url: string): Promise<void> {
  let guard = ddlByUrl.get(url);
  if (guard === undefined) {
    guard = (async () => {
      await db.execute(`CREATE TABLE IF NOT EXISTS executor_control_requests (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT,
        executor_id TEXT NOT NULL,
        process_instance_id TEXT,
        wg_id TEXT,
        action TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        authorized_by TEXT,
        requested_at_ms INTEGER NOT NULL,
        target_pid INTEGER,
        target_process_group_id INTEGER,
        target_process_start_identity TEXT,
        handled_at_ms INTEGER,
        applied_at_ms INTEGER,
        failed_at_ms INTEGER,
        result TEXT,
        failure TEXT
      )`);
      await addMissingColumns(db, 'executor_control_requests', [
        ['action_id', 'TEXT'],
        ['process_instance_id', 'TEXT'],
        ['wg_id', 'TEXT'],
        ['authorized_by', 'TEXT'],
        ['target_pid', 'INTEGER'],
        ['target_process_group_id', 'INTEGER'],
        ['target_process_start_identity', 'TEXT'],
        ['applied_at_ms', 'INTEGER'],
        ['failed_at_ms', 'INTEGER'],
        ['failure', 'TEXT'],
      ]);
      await db.execute(
        'CREATE INDEX IF NOT EXISTS idx_executor_control_pending ON executor_control_requests(executor_id, process_instance_id, handled_at_ms, seq)',
      );
      await db.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_control_action ON executor_control_requests(action_id)',
      );
    })().catch((error: unknown) => {
      ddlByUrl.delete(url);
      throw error;
    });
    ddlByUrl.set(url, guard);
  }
  return guard;
}

function actionsFor(status: ExecutorProcessStatus): readonly HumanExecutorAction[] {
  switch (status) {
    case 'running':
      return ['graceful_stop', 'terminate', 'force_kill'];
    case 'shutdown_pending':
    case 'shutdown_requested':
      return ['terminate', 'force_kill'];
    case 'terminate_requested':
      return ['force_kill'];
    case 'force_kill_requested':
      return [];
    case 'paused':
      return ['resume'];
    case 'resumed':
    case 'exited':
    case 'spawn_failed':
      return [];
  }
}

function statusEvent(status: ExecutorProcessStatus): MonitorEventKind {
  return status === 'running' ? 'executor_started' : `executor_${status}`;
}

function eventStatus(kind: MonitorEventKind): ExecutorProcessStatus | null {
  switch (kind) {
    case 'executor_started':
      return 'running';
    case 'executor_shutdown_pending':
      return 'shutdown_pending';
    case 'executor_shutdown_requested':
      return 'shutdown_requested';
    case 'executor_terminate_requested':
      return 'terminate_requested';
    case 'executor_force_kill_requested':
      return 'force_kill_requested';
    case 'executor_paused':
      return 'paused';
    case 'executor_resumed':
      return 'resumed';
    case 'executor_exited':
      return 'exited';
    case 'executor_spawn_failed':
      return 'spawn_failed';
    default:
      return null;
  }
}

function eventInstanceId(event: MonitorEvent): string | undefined {
  if (event.processInstanceId !== undefined) return event.processInstanceId;
  if (event.executorId === undefined || event.pid === undefined) return undefined;
  return `${event.executorId}:${String(event.pid)}:${event.processStartIdentity ?? 'legacy'}`;
}

function actionFromEvent(event: MonitorEvent): ExecutorActionAudit | undefined {
  if (
    event.actionId === undefined ||
    event.controlAction === undefined ||
    event.requestedBy === undefined ||
    event.authorizedBy === undefined ||
    event.requestedAtMs === undefined
  ) {
    return undefined;
  }
  return {
    actionId: event.actionId,
    action: event.controlAction,
    requestedBy: event.requestedBy,
    authorizedBy: event.authorizedBy,
    requestedAtMs: event.requestedAtMs,
    ...(event.appliedAtMs === undefined ? {} : { appliedAtMs: event.appliedAtMs }),
    ...(event.failedAtMs === undefined ? {} : { failedAtMs: event.failedAtMs }),
    ...(event.failure === undefined ? {} : { failure: event.failure }),
  };
}

function applyExecutorProcessEvent(
  byId: Map<string, ExecutorProcessState>,
  event: MonitorEvent,
): void {
  const executorId = event.executorId;
  if (executorId === undefined) return;
  const status = eventStatus(event.kind);
  const prior = byId.get(executorId);
  if (status === 'running') {
    const processInstanceId = eventInstanceId(event);
    if (
      processInstanceId === undefined ||
      event.pid === undefined ||
      event.processGroupId === undefined ||
      event.role === undefined
    ) {
      return;
    }
    byId.set(executorId, {
      executorId,
      processInstanceId,
      actor: event.role === 'orchestrator' ? 'parent' : 'executor',
      wgId: event.wgId,
      ...(event.runId === undefined ? {} : { runId: event.runId }),
      ...(event.checkpointStage === undefined ? {} : { checkpointStage: event.checkpointStage }),
      ...(event.lap === undefined ? {} : { lap: event.lap }),
      role: event.role,
      pid: event.pid,
      processGroupId: Math.abs(event.processGroupId),
      processStartIdentity: event.processStartIdentity ?? '',
      ...(event.windowsJobName === undefined ? {} : { windowsJobName: event.windowsJobName }),
      ...(event.windowsJobMetadata === undefined
        ? {}
        : { windowsJobMetadata: event.windowsJobMetadata }),
      status,
      startedAtMs: event.atMs,
      updatedAtMs: event.atMs,
      availableActions: actionsFor(status),
    });
    return;
  }
  if (prior === undefined) return;
  const processInstanceId = event.processInstanceId;
  if (processInstanceId !== undefined && processInstanceId !== prior.processInstanceId) return;
  const latestAction = actionFromEvent(event);
  if (status === null) {
    if (latestAction === undefined) return;
    byId.set(executorId, { ...prior, latestAction, updatedAtMs: event.atMs });
    return;
  }
  byId.set(executorId, {
    ...prior,
    status,
    updatedAtMs: event.atMs,
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(latestAction === undefined ? {} : { latestAction }),
    availableActions: actionsFor(status),
  });
}

export function foldExecutorProcesses(events: readonly MonitorEvent[]): ExecutorProcessState[] {
  const byId = new Map<string, ExecutorProcessState>();
  for (const event of events) applyExecutorProcessEvent(byId, event);
  return [...byId.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

interface ProcessProjection {
  cursor: number;
  readonly byId: Map<string, ExecutorProcessState>;
}
const processProjections = new Map<string, ProcessProjection>();
const projectionUpdates = new Map<string, Promise<void>>();

/** Incrementally consume the append-only event stream; repeated reads do not re-fold all history. */
async function projectedExecutorProcesses(): Promise<ExecutorProcessState[]> {
  const url = await loopDbUrl();
  const priorUpdate = projectionUpdates.get(url) ?? Promise.resolve();
  const update = priorUpdate.then(async () => {
    const projection = processProjections.get(url) ?? { cursor: 0, byId: new Map() };
    const events = await tailEventsSince(projection.cursor);
    for (const event of events) {
      applyExecutorProcessEvent(projection.byId, event);
      projection.cursor = Math.max(projection.cursor, event.seq);
    }
    processProjections.set(url, projection);
  });
  projectionUpdates.set(url, update);
  try {
    await update;
  } finally {
    if (projectionUpdates.get(url) === update) projectionUpdates.delete(url);
  }
  const projection = processProjections.get(url);
  return [...(projection?.byId.values() ?? [])].sort(
    (left, right) => right.updatedAtMs - left.updatedAtMs,
  );
}

export async function registerExecutorProcess(input: {
  executorId: string;
  processInstanceId?: string;
  wgId: string;
  runId?: string;
  checkpointStage?: string;
  lap?: number;
  role: string;
  pid: number;
  processGroupId: number;
  processStartIdentity?: string;
  windowsJob?: WindowsJobIdentity;
  nowMs?: number;
}): Promise<string> {
  const identity =
    input.processStartIdentity === undefined
      ? await readProcessIdentity(input.pid)
      : {
          processGroupId: Math.abs(input.processGroupId),
          startIdentity: input.processStartIdentity,
        };
  if (Math.abs(input.processGroupId) !== identity.processGroupId) {
    throw new Error(
      `owned process group mismatch for ${input.executorId}: expected ${String(Math.abs(input.processGroupId))}, found ${String(identity.processGroupId)}`,
    );
  }
  const processInstanceId = input.processInstanceId ?? randomUUID();
  await appendMonitorEvent({
    wgId: input.wgId,
    kind: 'executor_started',
    executorId: input.executorId,
    processInstanceId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.checkpointStage === undefined ? {} : { checkpointStage: input.checkpointStage }),
    ...(input.lap === undefined ? {} : { lap: input.lap }),
    role: input.role,
    pid: input.pid,
    processGroupId: identity.processGroupId,
    processStartIdentity: identity.startIdentity,
    ...(input.windowsJob === undefined
      ? {}
      : {
          windowsJobName: input.windowsJob.jobName,
          windowsJobMetadata: input.windowsJob.metadataPath,
        }),
    atMs: input.nowMs ?? Date.now(),
  });
  return processInstanceId;
}

export async function markExecutorProcess(
  executorId: string,
  status: ExecutorProcessStatus,
  exitCode?: number | null,
  requestedBy?: HumanControlSurface,
  knownWgId?: string,
  processInstanceId?: string,
  actionAudit?: ExecutorActionAudit,
): Promise<void> {
  const state = (await listExecutorProcesses()).find(
    (candidate) => candidate.executorId === executorId,
  );
  const wgId = knownWgId ?? state?.wgId;
  if (wgId === undefined) return;
  await appendMonitorEvent({
    wgId,
    kind: statusEvent(status),
    executorId,
    ...(processInstanceId === undefined ? {} : { processInstanceId }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(requestedBy === undefined ? {} : { requestedBy }),
    ...(actionAudit === undefined
      ? {}
      : {
          requestedBy: actionAudit.requestedBy,
          authorizedBy: actionAudit.authorizedBy,
          actionId: actionAudit.actionId,
          controlAction: actionAudit.action,
          requestedAtMs: actionAudit.requestedAtMs,
          ...(actionAudit.appliedAtMs === undefined
            ? {}
            : { appliedAtMs: actionAudit.appliedAtMs }),
          ...(actionAudit.failedAtMs === undefined ? {} : { failedAtMs: actionAudit.failedAtMs }),
          ...(actionAudit.failure === undefined ? {} : { failure: actionAudit.failure }),
        }),
    atMs: Date.now(),
  });
}

export async function listExecutorProcesses(activeOnly = false): Promise<ExecutorProcessState[]> {
  const states = await projectedExecutorProcesses();
  return activeOnly ? states.filter((state) => ACTIVE_STATUSES.has(state.status)) : states;
}

export interface RequestExecutorControlDeps {
  readonly readIdentity: (pid: number) => Promise<ProcessIdentity>;
  readonly kill: (pid: number, signal: NodeJS.Signals | number) => void;
  readonly mark: typeof markExecutorProcess;
  readonly controlWindows?: (
    identity: WindowsJobIdentity,
    action: 'terminate' | 'force_kill',
  ) => Promise<void>;
  readonly ownerWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_REQUEST_DEPS: RequestExecutorControlDeps = {
  readIdentity: readProcessIdentity,
  kill: (pid, signal) => process.kill(pid, signal),
  mark: markExecutorProcess,
  controlWindows: (identity, action) => controlWindowsJob(realProcControl, identity, action),
};

function isMissingOwnedProcess(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === 1 ||
    /no process found|cannot find a process|could not find process/iu.test(error.message)
  );
}

function assertAuthorizationIdentity(value: string): string {
  const identity = value.trim();
  if (identity === '') throw new Error('process-control authorization identity must be non-empty');
  return identity;
}

function rowRequest(row: Record<string, unknown>): ExecutorControlRequest {
  return {
    seq: Number(row.seq),
    actionId: typeof row.action_id === 'string' ? row.action_id : '',
    executorId: typeof row.executor_id === 'string' ? row.executor_id : '',
    processInstanceId: typeof row.process_instance_id === 'string' ? row.process_instance_id : '',
    wgId: typeof row.wg_id === 'string' ? row.wg_id : '',
    action: row.action as HumanProcessSignalAction,
    requestedBy: row.requested_by as HumanControlSurface,
    authorizedBy: typeof row.authorized_by === 'string' ? row.authorized_by : '',
    requestedAtMs: Number(row.requested_at_ms),
    targetPid: Number(row.target_pid),
    targetProcessGroupId: Number(row.target_process_group_id),
    targetProcessStartIdentity:
      typeof row.target_process_start_identity === 'string'
        ? row.target_process_start_identity
        : '',
  };
}

async function appendControlAudit(
  request: ExecutorControlRequest,
  result: 'requested' | 'applied' | 'failed',
  timestamp: number,
  failure?: string,
): Promise<void> {
  await appendMonitorEvent({
    wgId: request.wgId,
    kind:
      result === 'requested'
        ? 'executor_control_requested'
        : result === 'applied'
          ? 'executor_control_applied'
          : 'executor_control_failed',
    executorId: request.executorId,
    processInstanceId: request.processInstanceId,
    requestedBy: request.requestedBy,
    authorizedBy: request.authorizedBy,
    actionId: request.actionId,
    controlAction: request.action,
    requestedAtMs: request.requestedAtMs,
    ...(result === 'applied' ? { appliedAtMs: timestamp } : {}),
    ...(result === 'failed' ? { failedAtMs: timestamp, failure } : {}),
    atMs: timestamp,
  });
}

async function insertControlRequest(
  state: ExecutorProcessState,
  input: {
    action: HumanProcessSignalAction;
    requestedBy: HumanControlSurface;
    authorizedBy: string;
  },
): Promise<ExecutorControlRequest> {
  const request = await withLoopDb(async (db, url) => {
    await ensureTables(db, url);
    const requestedAtMs = Date.now();
    const actionId = randomUUID();
    const inserted = await db.execute({
      sql: `INSERT INTO executor_control_requests
              (action_id, executor_id, process_instance_id, wg_id, action, requested_by,
               authorized_by, requested_at_ms, target_pid, target_process_group_id,
               target_process_start_identity, handled_at_ms, applied_at_ms, failed_at_ms, result, failure)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL) RETURNING seq`,
      args: [
        actionId,
        state.executorId,
        state.processInstanceId,
        state.wgId,
        input.action,
        input.requestedBy,
        input.authorizedBy,
        requestedAtMs,
        state.pid,
        state.processGroupId,
        state.processStartIdentity,
      ],
    });
    return {
      seq: Number(inserted.rows[0]?.seq),
      actionId,
      executorId: state.executorId,
      processInstanceId: state.processInstanceId,
      wgId: state.wgId,
      action: input.action,
      requestedBy: input.requestedBy,
      authorizedBy: input.authorizedBy,
      requestedAtMs,
      targetPid: state.pid,
      targetProcessGroupId: state.processGroupId,
      targetProcessStartIdentity: state.processStartIdentity,
    } satisfies ExecutorControlRequest;
  });
  await appendControlAudit(request, 'requested', request.requestedAtMs);
  return request;
}

async function pendingRequests(
  executorId: string,
  processInstanceId: string,
): Promise<ExecutorControlRequest[]> {
  return withLoopDb(async (db, url) => {
    await ensureTables(db, url);
    const rs = await db.execute({
      sql: `SELECT seq, action_id, executor_id, process_instance_id, wg_id, action, requested_by,
                   authorized_by, requested_at_ms, target_pid, target_process_group_id,
                   target_process_start_identity
            FROM executor_control_requests
            WHERE executor_id=? AND process_instance_id=? AND handled_at_ms IS NULL AND result IS NULL
            ORDER BY seq ASC`,
      args: [executorId, processInstanceId],
    });
    return rs.rows.map((row) => rowRequest(row as Record<string, unknown>));
  });
}

async function claimRequest(seq: number, claimant: 'owner' | 'direct'): Promise<boolean> {
  return withLoopDb(async (db, url) => {
    await ensureTables(db, url);
    const claimed = await db.execute({
      sql: 'UPDATE executor_control_requests SET result=? WHERE seq=? AND handled_at_ms IS NULL AND result IS NULL',
      args: [`authorizing:${claimant}`, seq],
    });
    return claimed.rowsAffected === 1;
  });
}

async function finishRequest(seq: number, failure?: string): Promise<ExecutorControlReceipt> {
  const completed = await withLoopDb(async (db, url) => {
    await ensureTables(db, url);
    const now = Date.now();
    await db.execute({
      sql: `UPDATE executor_control_requests
            SET handled_at_ms=?, applied_at_ms=?, failed_at_ms=?, result=?, failure=?
            WHERE seq=? AND handled_at_ms IS NULL`,
      args: [
        now,
        failure === undefined ? now : null,
        failure === undefined ? null : now,
        failure === undefined ? 'applied' : 'failed',
        failure ?? null,
        seq,
      ],
    });
    const rs = await db.execute({
      sql: `SELECT seq, action_id, executor_id, process_instance_id, wg_id, action, requested_by,
                   authorized_by, requested_at_ms, target_pid, target_process_group_id,
                   target_process_start_identity, applied_at_ms, failed_at_ms, result, failure
            FROM executor_control_requests WHERE seq=?`,
      args: [seq],
    });
    const row = rs.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`control request ${String(seq)} disappeared`);
    const request = rowRequest(row);
    const result = row.result === 'applied' ? 'applied' : 'failed';
    return {
      ...request,
      result,
      ...(row.applied_at_ms === null || row.applied_at_ms === undefined
        ? {}
        : { appliedAtMs: Number(row.applied_at_ms) }),
      ...(row.failed_at_ms === null || row.failed_at_ms === undefined
        ? {}
        : { failedAtMs: Number(row.failed_at_ms) }),
      ...(typeof row.failure === 'string' ? { failure: row.failure } : {}),
    } satisfies ExecutorControlReceipt;
  });
  const timestamp = completed.appliedAtMs ?? completed.failedAtMs ?? Date.now();
  await appendControlAudit(
    completed,
    completed.result === 'applied' ? 'applied' : 'failed',
    timestamp,
    completed.failure,
  );
  return completed;
}

async function readReceipt(seq: number): Promise<ExecutorControlReceipt | null> {
  return withLoopDb(async (db, url) => {
    await ensureTables(db, url);
    const rs = await db.execute({
      sql: `SELECT seq, action_id, executor_id, process_instance_id, wg_id, action, requested_by,
                   authorized_by, requested_at_ms, target_pid, target_process_group_id,
                   target_process_start_identity, handled_at_ms, applied_at_ms, failed_at_ms, result, failure
            FROM executor_control_requests WHERE seq=?`,
      args: [seq],
    });
    const row = rs.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const request = rowRequest(row);
    if (row.handled_at_ms === null || row.handled_at_ms === undefined) {
      return { ...request, result: 'queued' };
    }
    return {
      ...request,
      result: row.result === 'applied' ? 'applied' : 'failed',
      ...(row.applied_at_ms === null || row.applied_at_ms === undefined
        ? {}
        : { appliedAtMs: Number(row.applied_at_ms) }),
      ...(row.failed_at_ms === null || row.failed_at_ms === undefined
        ? {}
        : { failedAtMs: Number(row.failed_at_ms) }),
      ...(typeof row.failure === 'string' ? { failure: row.failure } : {}),
    };
  });
}

export async function getExecutorControlReceipt(
  actionId: string,
): Promise<ExecutorControlReceipt | null> {
  const normalized = actionId.trim();
  if (normalized === '') throw new Error('actionId must be non-empty');
  return withLoopDb(async (db, url) => {
    await ensureTables(db, url);
    const rs = await db.execute({
      sql: `SELECT seq, action_id, executor_id, process_instance_id, wg_id, action, requested_by,
                   authorized_by, requested_at_ms, target_pid, target_process_group_id,
                   target_process_start_identity, handled_at_ms, applied_at_ms, failed_at_ms, result, failure
            FROM executor_control_requests WHERE action_id=?`,
      args: [normalized],
    });
    const row = rs.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const request = rowRequest(row);
    if (row.handled_at_ms === null || row.handled_at_ms === undefined) {
      return { ...request, result: 'queued' };
    }
    return {
      ...request,
      result: row.result === 'applied' ? 'applied' : 'failed',
      ...(row.applied_at_ms === null || row.applied_at_ms === undefined
        ? {}
        : { appliedAtMs: Number(row.applied_at_ms) }),
      ...(row.failed_at_ms === null || row.failed_at_ms === undefined
        ? {}
        : { failedAtMs: Number(row.failed_at_ms) }),
      ...(typeof row.failure === 'string' ? { failure: row.failure } : {}),
    };
  });
}

async function requestOneExecutorControl(
  input: {
    executorId: string;
    action: HumanProcessSignalAction;
    requestedBy: HumanControlSurface;
    authorizedBy: string;
  },
  deps: RequestExecutorControlDeps = DEFAULT_REQUEST_DEPS,
): Promise<ExecutorControlReceipt> {
  const authorizedBy = assertAuthorizationIdentity(input.authorizedBy);
  const processState = (await listExecutorProcesses()).find(
    (state) => state.executorId === input.executorId,
  );
  if (!processState?.availableActions.includes(input.action)) {
    throw new Error(
      `executor ${input.executorId} does not allow ${input.action} from status ${processState?.status ?? 'missing'}`,
    );
  }
  const request = await insertControlRequest(processState, { ...input, authorizedBy });
  const ownerWaitMs = deps.ownerWaitMs ?? 750;
  const configuredSleep = deps.sleep;
  const sleep =
    configuredSleep === undefined
      ? (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
      : (ms: number) => configuredSleep(ms);

  if (input.action === 'graceful_stop') {
    await deps.mark(
      input.executorId,
      'shutdown_requested',
      undefined,
      input.requestedBy,
      processState.wgId,
      processState.processInstanceId,
      {
        actionId: request.actionId,
        action: request.action,
        requestedBy: request.requestedBy,
        authorizedBy: request.authorizedBy,
        requestedAtMs: request.requestedAtMs,
      },
    );
  }

  const waitDeadline = Date.now() + ownerWaitMs;
  while (Date.now() < waitDeadline) {
    const receipt = await readReceipt(request.seq);
    if (receipt?.result === 'applied' || receipt?.result === 'failed') return receipt;
    await sleep(Math.min(25, Math.max(1, waitDeadline - Date.now())));
  }
  if (input.action === 'graceful_stop') return { ...request, result: 'queued' };

  if (!(await claimRequest(request.seq, 'direct'))) {
    const deadline = Date.now() + Math.max(100, ownerWaitMs);
    while (Date.now() < deadline) {
      const receipt = await readReceipt(request.seq);
      if (receipt?.result === 'applied' || receipt?.result === 'failed') return receipt;
      await sleep(10);
    }
    return { ...request, result: 'queued' };
  }

  try {
    let identity: ProcessIdentity;
    try {
      identity = await deps.readIdentity(request.targetPid);
    } catch (error) {
      if (!isMissingOwnedProcess(error)) throw error;
      // The exact registered PID is already absent, so the requested end-state is satisfied. Reconcile the
      // stale read model instead of reporting a failed action against a process that no longer exists.
      await deps.mark(
        input.executorId,
        'paused',
        undefined,
        input.requestedBy,
        processState.wgId,
        processState.processInstanceId,
        {
          actionId: request.actionId,
          action: request.action,
          requestedBy: request.requestedBy,
          authorizedBy: request.authorizedBy,
          requestedAtMs: request.requestedAtMs,
        },
      );
      return await finishRequest(request.seq);
    }
    if (
      identity.startIdentity !== request.targetProcessStartIdentity ||
      identity.processGroupId !== request.targetProcessGroupId
    ) {
      throw new Error(`owned process identity changed for ${input.executorId}; refusing OS signal`);
    }
    const osAction: 'terminate' | 'force_kill' =
      input.action === 'terminate' ? 'terminate' : 'force_kill';
    const status = osAction === 'terminate' ? 'terminate_requested' : 'force_kill_requested';
    await deps.mark(
      input.executorId,
      status,
      undefined,
      input.requestedBy,
      processState.wgId,
      processState.processInstanceId,
      {
        actionId: request.actionId,
        action: request.action,
        requestedBy: request.requestedBy,
        authorizedBy: request.authorizedBy,
        requestedAtMs: request.requestedAtMs,
      },
    );
    if (process.platform === 'win32') {
      if (
        processState.windowsJobName === undefined ||
        processState.windowsJobMetadata === undefined ||
        deps.controlWindows === undefined
      ) {
        throw new Error(`owned Windows Job Object metadata is unavailable for ${input.executorId}`);
      }
      await deps.controlWindows(
        {
          jobName: processState.windowsJobName,
          metadataPath: processState.windowsJobMetadata,
        },
        osAction,
      );
    } else {
      deps.kill(-identity.processGroupId, osAction === 'terminate' ? 'SIGTERM' : 'SIGKILL');
    }
    return await finishRequest(request.seq);
  } catch (error) {
    return finishRequest(request.seq, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Execute one human action through the shared SDK contract. A parent is the control root for its run: the same
 * human authorization is propagated to every active executor process in that run so a parent stop cannot leave
 * detached executor groups launching work after the logical run is paused.
 */
export async function requestExecutorControl(
  input: {
    executorId: string;
    action: HumanProcessSignalAction;
    requestedBy: HumanControlSurface;
    authorizedBy: string;
  },
  deps: RequestExecutorControlDeps = DEFAULT_REQUEST_DEPS,
): Promise<ExecutorControlReceipt> {
  const states = await listExecutorProcesses();
  const target = states.find((state) => state.executorId === input.executorId);
  const receipt = await requestOneExecutorControl(input, deps);
  if (target?.actor !== 'parent' || target.runId === undefined) return receipt;

  const children = states.filter(
    (state) =>
      state.executorId !== target.executorId &&
      state.runId === target.runId &&
      state.availableActions.includes(input.action),
  );
  const related = await Promise.all(
    children.map((child) =>
      requestOneExecutorControl(
        {
          executorId: child.executorId,
          action: input.action,
          requestedBy: input.requestedBy,
          authorizedBy: input.authorizedBy,
        },
        deps,
      ),
    ),
  );
  return related.length === 0 ? receipt : { ...receipt, related };
}

export interface ControlledProcess {
  readonly processInstanceId: string;
  readonly procControl: ProcControl;
  markAutomaticShutdown(): void;
  shutdownCause(): ProcessShutdownCause | null;
  dispose(): void;
}

export interface ProcessControlStoreDeps {
  register: typeof registerExecutorProcess;
  mark: typeof markExecutorProcess;
  pending: typeof pendingRequests;
  claim: typeof claimRequest;
  complete: typeof finishRequest;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

const DEFAULT_STORE_DEPS: ProcessControlStoreDeps = {
  register: registerExecutorProcess,
  mark: markExecutorProcess,
  pending: pendingRequests,
  claim: claimRequest,
  complete: finishRequest,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

/**
 * Attach one subprocess incarnation to the shared control plane.
 * The shared transport owns bounded automatic TERM→KILL cleanup; explicit human actions still require an
 * authorization identity and target this exact registered process incarnation.
 */
export function controlledExecutorProcess(input: {
  executorId: string;
  wgId: string;
  role: string;
  runId?: string;
  checkpointStage?: string;
  lap?: number;
  base: ProcControl;
  automaticSignal?: AbortSignal;
  pollMs?: number;
  store?: ProcessControlStoreDeps;
  processInstanceId?: string;
}): ControlledProcess {
  const store = input.store ?? DEFAULT_STORE_DEPS;
  const processInstanceId = input.processInstanceId ?? randomUUID();
  const windowsJob =
    process.platform === 'win32' ? createWindowsJobIdentity(processInstanceId) : undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let timer: NodeJS.Timeout | undefined;
  let registration: Promise<unknown> | undefined;
  let closed = false;
  let detached = false;
  let automaticShutdownRequested = false;
  let shutdownCause: ProcessShutdownCause | null = null;
  let terminal:
    | {
        status: 'exited' | 'paused' | 'terminate_requested' | 'spawn_failed';
        exitCode?: number | null;
      }
    | undefined;

  const mark = (
    status: ExecutorProcessStatus,
    exitCode?: number | null,
    requestedBy?: HumanControlSurface,
    actionAudit?: ExecutorActionAudit,
  ): Promise<void> =>
    store.mark(
      input.executorId,
      status,
      exitCode,
      requestedBy,
      input.wgId,
      processInstanceId,
      actionAudit,
    );
  const signalOwned = async (
    action: 'terminate' | 'force_kill',
    signal: NodeJS.Signals,
  ): Promise<void> => {
    if (child === undefined || typeof child.pid !== 'number') return;
    if (windowsJob !== undefined) {
      await controlWindowsJob(input.base, windowsJob, action);
      return;
    }
    const target = !detached ? child.pid : -child.pid;
    input.base.kill(target, signal);
  };
  const graceful = (status: 'shutdown_pending' | 'shutdown_requested'): void => {
    if (status === 'shutdown_pending') {
      automaticShutdownRequested = true;
      shutdownCause ??= { kind: 'automatic' };
    }
    void mark(status).catch(() => undefined);
    try {
      child?.stdin.end();
    } catch {
      // The status remains visible; the human may choose terminate/force-kill.
    }
  };
  const applyRequest = async (request: ExecutorControlRequest): Promise<void> => {
    if (!(await store.claim(request.seq, 'owner'))) return;
    try {
      shutdownCause = {
        kind: 'human',
        action: request.action,
        requestedBy: request.requestedBy,
        authorizedBy: request.authorizedBy,
        actionId: request.actionId,
      };
      const audit: ExecutorActionAudit = {
        actionId: request.actionId,
        action: request.action,
        requestedBy: request.requestedBy,
        authorizedBy: request.authorizedBy,
        requestedAtMs: request.requestedAtMs,
      };
      if (request.action === 'graceful_stop') {
        await mark('shutdown_requested', undefined, request.requestedBy, audit);
        try {
          child?.stdin.end();
        } catch {
          // The durable status remains actionable for terminate/force-kill.
        }
      } else if (request.action === 'terminate') {
        await mark('terminate_requested', undefined, request.requestedBy, audit);
        await signalOwned('terminate', 'SIGTERM');
      } else {
        await mark('force_kill_requested', undefined, request.requestedBy, audit);
        await signalOwned('force_kill', 'SIGKILL');
      }
      await store.complete(request.seq);
    } catch (error) {
      await store.complete(request.seq, error instanceof Error ? error.message : String(error));
    }
  };
  const schedule = (): void => {
    if (closed) return;
    timer = store.setTimeout(() => void poll(), input.pollMs ?? 250);
    timer.unref?.();
  };
  const poll = async (): Promise<void> => {
    if (closed) return;
    try {
      for (const request of await store.pending(input.executorId, processInstanceId)) {
        await applyRequest(request);
      }
    } finally {
      schedule();
    }
  };
  const onAutomaticAbort = (): void => graceful('shutdown_pending');
  input.automaticSignal?.addEventListener('abort', onAutomaticAbort, { once: true });

  const terminateTreeStillAlive = (): boolean => {
    if (process.platform === 'win32') return false; // terminate targets the entire named Job Object
    if (!detached || child === undefined || typeof child.pid !== 'number') return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const dispose = (): void => {
    input.automaticSignal?.removeEventListener('abort', onAutomaticAbort);
  };

  return {
    processInstanceId,
    markAutomaticShutdown: () => graceful('shutdown_pending'),
    shutdownCause: () => shutdownCause,
    dispose,
    procControl: {
      ...input.base,
      signalTree: (proc, treeDetached, signal) => {
        if (windowsJob !== undefined) {
          return controlWindowsJob(
            input.base,
            windowsJob,
            signal === 'SIGKILL' ? 'force_kill' : 'terminate',
          );
        }
        if (input.base.signalTree !== undefined) {
          return input.base.signalTree(proc, treeDetached, signal);
        }
        if (treeDetached && typeof proc.pid === 'number') input.base.kill(-proc.pid, signal);
        else proc.kill(signal);
      },
      isTreeAlive: (proc, treeDetached) => {
        // The broker closes only after its Job Object is empty. Its close event therefore proves Windows-tree
        // drain; before close the owner must remain pending.
        if (windowsJob !== undefined) return !closed;
        if (input.base.isTreeAlive !== undefined) return input.base.isTreeAlive(proc, treeDetached);
        if (typeof proc.pid !== 'number') return false;
        try {
          input.base.kill(treeDetached ? -proc.pid : proc.pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      spawn: (cli, args, options) => {
        const proc =
          windowsJob === undefined
            ? input.base.spawn(cli, args, options)
            : spawnInWindowsJob(input.base, windowsJob, cli, args, options);
        child = proc;
        detached = windowsJob !== undefined || options.detached === true;
        if (typeof proc.pid === 'number') {
          registration = store.register({
            executorId: input.executorId,
            processInstanceId,
            wgId: input.wgId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.checkpointStage === undefined
              ? {}
              : { checkpointStage: input.checkpointStage }),
            ...(input.lap === undefined ? {} : { lap: input.lap }),
            role: input.role,
            pid: proc.pid,
            processGroupId: proc.pid,
            ...(windowsJob === undefined ? {} : { windowsJob }),
          });
          void registration
            .then(() => {
              if (terminal !== undefined) void mark(terminal.status, terminal.exitCode);
              else {
                if (automaticShutdownRequested) void mark('shutdown_pending');
                void poll();
              }
            })
            .catch(() => undefined);
        }
        proc.once('close', (code) => {
          closed = true;
          const humanAction = shutdownCause?.kind === 'human' ? shutdownCause.action : undefined;
          const status =
            humanAction === 'graceful_stop' || humanAction === 'force_kill'
              ? 'paused'
              : humanAction === 'terminate'
                ? terminateTreeStillAlive()
                  ? 'terminate_requested'
                  : 'paused'
                : 'exited';
          terminal = { status, exitCode: code };
          if (timer !== undefined) store.clearTimeout(timer);
          void mark(status, code).catch(() => undefined);
          dispose();
        });
        proc.once('error', () => {
          closed = true;
          terminal = { status: 'spawn_failed' };
          if (timer !== undefined) store.clearTimeout(timer);
          void mark('spawn_failed').catch(() => undefined);
          dispose();
        });
        if (input.automaticSignal?.aborted === true) onAutomaticAbort();
        return proc;
      },
    },
  };
}

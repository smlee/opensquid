/**
 * AP.1 — mirror the harness task store into opensquid's active-task signal.
 *
 * The whole automation gate-set keys off `active-task.json` (design rules
 * #1/#8/#16). This module is the ONLY place that knows the Claude-Code-specific
 * task-store path — every gate reads opensquid's own `active-task.json`,
 * harness-agnostic (substrate-vs-consumer discipline).
 *
 * WHY mirror the store rather than reconstruct from the tool-call args: a
 * `TaskCreate` PreToolUse payload carries `subject` but NO id (the harness
 * assigns the id in the RESPONSE, which a PreToolUse hook never sees), and a
 * `TaskUpdate(in_progress)` payload carries `taskId` but NO subject — and the
 * two events share no key, so they cannot be correlated. The canonical store
 * `~/.claude/tasks/<session-id>/<task-id>.json` carries `{id, subject, status,
 * metadata}` together; we read it and pick the `in_progress` task.
 *
 * Timing (H4a): `PreToolUse` fires BEFORE the tool executes, so on a status
 * TRANSITION the on-disk file still holds the OLD status. We therefore honor the
 * pending `args` for both directions — the task being moved to `in_progress`
 * becomes active even though disk still says `pending`; the task being
 * `completed`/`deleted` is excluded even though disk still says `in_progress`.
 *
 * Best-effort + fail-open: never throws into the hook (the caller also guards).
 *
 * Imports from: node:fs/promises, node:os, node:path, ../session_state.js.
 * Imported by: src/runtime/hooks/pre-tool-use.ts.
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type ActiveTask,
  clearActiveTask,
  readActiveTask,
  writeActiveTask,
} from '../session_state.js';

/**
 * T-ATSC L1 (2026-05-29) — mirror re-derives `active-task.json` on EVERY
 * PreToolUse, not only on `TaskCreate`/`TaskUpdate` ticks. Pre-T-ATSC the
 * mirror short-circuited on the harness task tools, leaving a race window
 * where `active-task.json` could stay absent across the whole code phase
 * (root cause of SIC commit fc0801a sailing past the workflow gate). With
 * L1 the mirror reads the harness store on every PreToolUse: the H4a
 * status overlay + AP.7 metadata overlay safely no-op for non-task tools
 * (activatingId / completingId both null, args.metadata undefined → falls
 * through to the on-disk store-derived view). Cost: ~5 ms per call
 * (readdir + N small readFile); benefit: race-class elimination. The
 * write path stays idempotent (writeActiveTask is tmp+rename atomic), so
 * unchanged-state PreToolUse calls cost just the read.
 */

export interface HarnessTask {
  id: string;
  subject: string;
  status: string;
  metadata?: { taskId?: string; spec?: string };
}

/**
 * Harness task-store directory for a session. `base` is injectable (the mirror
 * passes it in tests); when omitted, an `OPENSQUID_HARNESS_TASKS_DIR` env
 * override wins (lets the Gate B primitive — which has no `base` seam — be
 * tested, and lets a user relocate the store), else the codebase-convention
 * default `join(homedir(), '.claude', 'tasks')`.
 */
export const harnessTasksDir = (sessionId: string, base?: string): string =>
  join(
    base ?? process.env.OPENSQUID_HARNESS_TASKS_DIR ?? join(homedir(), '.claude', 'tasks'),
    sessionId,
  );

/**
 * Read + parse the harness task store for a session. Returns `[]` on an absent
 * dir (no tasks yet) and skips malformed / shape-invalid entries. Never throws.
 */
export async function readHarnessTasks(sessionId: string, base?: string): Promise<HarnessTask[]> {
  const dir = harnessTasksDir(sessionId, base);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // dir absent → no tasks
  }
  const tasks: HarnessTask[] = [];
  for (const name of entries) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue; // skip .lock/.highwatermark
    try {
      const o = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
      if (
        typeof o.id !== 'string' ||
        typeof o.subject !== 'string' ||
        typeof o.status !== 'string'
      ) {
        continue;
      }
      const task: HarnessTask = { id: o.id, subject: o.subject, status: o.status };
      if (o.metadata !== null && typeof o.metadata === 'object') {
        const m = o.metadata as Record<string, unknown>;
        const meta: { taskId?: string; spec?: string } = {};
        if (typeof m.taskId === 'string') meta.taskId = m.taskId;
        if (typeof m.spec === 'string') meta.spec = m.spec;
        if (meta.taskId !== undefined || meta.spec !== undefined) task.metadata = meta;
      }
      tasks.push(task);
    } catch {
      // malformed task file → skip; one bad file must not blind the whole mirror
    }
  }
  return tasks;
}

/**
 * Mirror the harness in-progress task into opensquid's `active-task.json`.
 * No-op for non-task tools. Writes the signal when a task is active, clears it
 * when none is. Best-effort: resolves without throwing on any I/O failure.
 */
export async function mirrorActiveTask(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
  base?: string,
): Promise<void> {
  // T-ATSC L1: no tool-name gate. Mirror re-derives on every PreToolUse so
  // active-task.json stays in sync with the harness store even when the
  // current tool is Write/Edit/Bash/Read/anything else. The H4a +
  // AP.7 overlays below pass through for non-TaskUpdate tools (their
  // args.taskId / args.status / args.metadata are undefined; activatingId
  // and completingId both null; the store-derived view is canonical).

  const tasks = await readHarnessTasks(sessionId, base);

  // H4a — the on-disk status lags a transition (PreToolUse is pre-execution).
  const taskId = typeof args.taskId === 'string' ? args.taskId : null;
  const activatingId = tool === 'TaskUpdate' && args.status === 'in_progress' ? taskId : null;
  const completingId =
    tool === 'TaskUpdate' && (args.status === 'completed' || args.status === 'deleted')
      ? taskId
      : null;

  // 1. A task being activated this tick wins (disk may still say 'pending').
  let active: HarnessTask | null = activatingId
    ? (tasks.find((t) => t.id === activatingId) ?? null)
    : null;
  // 2. Otherwise the on-disk in_progress task, excluding one being closed this tick.
  active ??= tasks.find((t) => t.status === 'in_progress' && t.id !== completingId) ?? null;

  if (!active) {
    // T-ACTRACE.1 (2026-05-31): defensive clear. Before clearing,
    // verify the previously-active task is GENUINELY absent from the
    // harness store — not just transiently non-in_progress (mid-write
    // snapshot). If the prior task is still present at ANY status, keep
    // active-task.json intact + return; subsequent PreToolUse re-mirrors
    // will rewrite once the harness mid-write completes. Race scenario:
    // log_phase pre_research → ok; intervening Edit triggers PreToolUse
    // → mirror reads store mid-TaskUpdate write → no in_progress
    // visible → pre-fix would clear → next log_phase throws "no active
    // task". This narrows the clear path to require positive evidence
    // (prior id genuinely absent from tasks[]).
    //
    // L3 risk callout: this MUST NOT prevent legitimate clears in
    // genuine no-task states. If readActiveTask returns null (no prior
    // active-task.json) OR tasks.some(t.id === prior.id) is FALSE
    // (prior genuinely removed), clear proceeds as before. Test cases
    // (d) and (e) verify this.
    try {
      const prior = await readActiveTask(sessionId);
      // Don't defensive-keep if the prior IS the task being completed
      // this tick — H4a completion case: TaskUpdate(completed) for the
      // active task while disk still says in_progress. The completingId
      // signal is the authoritative "you ARE done" message; the prior's
      // continued presence on disk at in_progress reflects the
      // pre-execution state. Test "H4a completion: excludes a task
      // being completed even though disk still says in_progress" asserts
      // this — we MUST clear.
      if (prior !== null && prior.id !== completingId && tasks.some((t) => t.id === prior.id)) {
        return; // transient mid-write — keep prior active-task.json
      }
    } catch {
      // L4 fail-open: readActiveTask error → fall through to clear.
    }
    await clearActiveTask(sessionId);
    return;
  }
  // H4a (metadata) — a TaskUpdate that stamps metadata reaches the store only
  // AFTER this PreToolUse fires, so the store read above is stale for it. Prefer
  // the pending args.metadata for the active task (same rationale as the
  // args.status merge above). Only TaskUpdate targeting the active id: TaskCreate
  // creates a pending task (not active) and carries no id at PreToolUse.
  const pendingMeta =
    tool === 'TaskUpdate' &&
    args.taskId === active.id &&
    args.metadata !== null &&
    typeof args.metadata === 'object'
      ? (args.metadata as { taskId?: unknown; spec?: unknown })
      : undefined;
  const provTaskId =
    typeof pendingMeta?.taskId === 'string' ? pendingMeta.taskId : active.metadata?.taskId;
  const provSpec = typeof pendingMeta?.spec === 'string' ? pendingMeta.spec : active.metadata?.spec;
  const signal: ActiveTask = {
    id: active.id,
    subject: active.subject,
    started_at: new Date().toISOString(),
    ...(provTaskId !== undefined ? { taskId: provTaskId } : {}),
    ...(provSpec !== undefined ? { spec: provSpec } : {}),
  };
  await writeActiveTask(sessionId, signal);
}

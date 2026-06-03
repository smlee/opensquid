/**
 * Transcript-derived active task (T-ATM ATM.1).
 *
 * THIS Claude Code version keeps the task list in the session transcript
 * (`.jsonl`), NOT at `~/.claude/tasks/<session>/<id>.json` (that path is empty
 * for live sessions). So the active-task signal must be derived from the
 * transcript the PreToolUse hook receives:
 *   - `TaskCreate` tool_use carries `input.{subject,metadata}` + a `tool_use_id`;
 *     the harness-assigned id is in the matching `tool_result` text
 *     ("Task #<id> created …") — correlate by `tool_use_id`.
 *   - `TaskUpdate` tool_use carries `{taskId, status, metadata}`.
 * The active task = the one most-recently set `in_progress` and not since
 * `completed`/`deleted`.
 *
 * Defensive per-line parse (the transcript schema is harness-owned + can shift):
 * any failure resolves to `null` (no active task) — NEVER a wrong task.
 *
 * Imports from: node:fs/promises, ../session_state.js.
 * Imported by: src/runtime/hooks/active_task_mirror.ts.
 */

import { readFile } from 'node:fs/promises';

import type { ActiveTask } from '../session_state.js';

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}
interface Entry {
  message?: { content?: unknown };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c !== null && typeof c === 'object' && typeof (c as Block).type === 'string'
          ? ((c as { text?: unknown }).text ?? '')
          : '',
      )
      .map((t) => (typeof t === 'string' ? t : ''))
      .join('');
  }
  return '';
}

/** The in-flight TaskUpdate that triggered THIS PreToolUse — not yet in the
 *  transcript (PreToolUse fires pre-execution). Overlaid last (H4a). */
export interface PendingUpdate {
  taskId: string;
  status: string;
  metadata?: Record<string, unknown>;
}

interface TaskState {
  subject: string;
  status: string;
  metadata: Record<string, unknown>;
}

/**
 * Shared transcript walk (ATM.1 + ATM.2): parse `TaskCreate`/`TaskUpdate`
 * records into the latest state per harness task id, plus the most-recent
 * `in_progress` id (not subsequently closed). Status is SEEDED to `pending` on
 * `TaskCreate` (the harness default) so a created-but-never-updated task still
 * counts as open. `pending` overlays the in-flight TaskUpdate (H4a), applied
 * last. Defensive per-line parse; an unreadable transcript yields an empty map
 * (fail-open — never a wrong task).
 */
async function parseTranscriptTasks(
  transcriptPath: string,
  pending?: PendingUpdate,
): Promise<{ taskById: Map<string, TaskState>; activeId: string | null }> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return { taskById: new Map(), activeId: null };
  }

  const createByToolUse = new Map<string, { subject: string; metadata: Record<string, unknown> }>();
  const idByToolUse = new Map<string, string>(); // tool_use_id → harness task id (from result)
  const updates: { taskId: string; status: string; metadata?: Record<string, unknown> }[] = [];

  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // a malformed line must not abort the walk
    }
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (b === null || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'TaskCreate' && typeof b.id === 'string') {
        const input = b.input ?? {};
        if (typeof input.subject === 'string') {
          const md =
            input.metadata !== null && typeof input.metadata === 'object'
              ? (input.metadata as Record<string, unknown>)
              : {};
          createByToolUse.set(b.id, { subject: input.subject, metadata: md });
        }
      } else if (b.type === 'tool_use' && b.name === 'TaskUpdate') {
        const input = b.input ?? {};
        if (typeof input.taskId === 'string' && typeof input.status === 'string') {
          const md =
            input.metadata !== null && typeof input.metadata === 'object'
              ? (input.metadata as Record<string, unknown>)
              : undefined;
          updates.push({
            taskId: input.taskId,
            status: input.status,
            ...(md ? { metadata: md } : {}),
          });
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const m = /Task #(\S+) created/.exec(resultText(b.content));
        if (m?.[1] !== undefined) idByToolUse.set(b.tool_use_id, m[1]);
      }
    }
  }

  const taskById = new Map<string, TaskState>();
  for (const [tuid, c] of createByToolUse) {
    const id = idByToolUse.get(tuid);
    if (id !== undefined)
      taskById.set(id, { subject: c.subject, status: 'pending', metadata: { ...c.metadata } });
  }

  // H4a: apply the in-flight TaskUpdate LAST (it's not in the transcript yet).
  if (pending !== undefined) updates.push(pending);

  let activeId: string | null = null;
  for (const u of updates) {
    let t = taskById.get(u.taskId);
    if (t === undefined) {
      t = { subject: '', status: 'pending', metadata: {} };
      taskById.set(u.taskId, t);
    }
    if (u.metadata !== undefined) t.metadata = { ...t.metadata, ...u.metadata };
    t.status = u.status;
    if (u.status === 'in_progress') activeId = u.taskId;
    else if ((u.status === 'completed' || u.status === 'deleted') && activeId === u.taskId) {
      activeId = null;
    }
  }

  return { taskById, activeId };
}

/**
 * Resolve the active task from the session transcript, or `null` if none /
 * unreadable. Most-recent `in_progress` (not later closed) wins. `pending`
 * overlays the in-flight TaskUpdate (H4a) so a task being activated THIS tick
 * wins even though disk/transcript still lags.
 */
export async function readActiveTaskFromTranscript(
  transcriptPath: string,
  pending?: PendingUpdate,
): Promise<ActiveTask | null> {
  const { taskById, activeId } = await parseTranscriptTasks(transcriptPath, pending);
  if (activeId === null) return null;
  const t = taskById.get(activeId);
  if (t === undefined) return null;
  const meta = t.metadata;
  return {
    id: activeId,
    subject: t.subject,
    started_at: new Date().toISOString(),
    ...(typeof meta.taskId === 'string' ? { taskId: meta.taskId } : {}),
    ...(typeof meta.spec === 'string' ? { spec: meta.spec } : {}),
  };
}

/**
 * Latest transcript status for one harness task id (with the in-flight TaskUpdate
 * overlaid, H4a), or `null` if the id is absent/unreadable. Reuses the ATM.1 walk —
 * no forked semantics. FC.6 uses this to tell genuine transcript lag (prior still
 * `pending`/`in_progress`) from a real completion (clear).
 */
export async function transcriptTaskStatus(
  transcriptPath: string,
  id: string,
  pending?: PendingUpdate,
): Promise<string | null> {
  const { taskById } = await parseTranscriptTasks(transcriptPath, pending);
  return taskById.get(id)?.status ?? null;
}

/**
 * A CLOSED status is the only case where a stale prior active-task signal must be
 * cleared. `null` (transcript hasn't caught up — genuine lag) and the open statuses
 * (`pending`/`in_progress`) both KEEP, so the ATM.3 lag-keep is preserved; only an
 * explicit `completed`/`deleted` clears (FC.6).
 */
export const isClosedStatus = (s: string | null): boolean =>
  s === 'completed' || s === 'deleted';

/** An OPEN task (latest status `pending`|`in_progress`) + its generator provenance. */
export interface OpenTask {
  id: string;
  status: string;
  taskId?: string;
}

/**
 * The OPEN tasks from the transcript (latest status ∈ {`pending`,
 * `in_progress`}), each with its `metadata.taskId` provenance if present.
 * Consumed by Gate B (`task_list_generated`) to flag tasks smuggled into the
 * list without going through scope→task-spec-author. Empty on an unreadable
 * transcript (fail-open). Shares the ATM.1 walk via `parseTranscriptTasks`.
 */
export async function readOpenTasksFromTranscript(
  transcriptPath: string,
  pending?: PendingUpdate,
): Promise<OpenTask[]> {
  const { taskById } = await parseTranscriptTasks(transcriptPath, pending);
  const open: OpenTask[] = [];
  for (const [id, t] of taskById) {
    if (t.status === 'completed' || t.status === 'deleted') continue;
    const taskId = typeof t.metadata.taskId === 'string' ? t.metadata.taskId : undefined;
    open.push({ id, status: t.status, ...(taskId !== undefined ? { taskId } : {}) });
  }
  return open;
}

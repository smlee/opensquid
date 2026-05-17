/**
 * Shared transcript-JSONL helpers for hooks that need to read what the
 * last user or assistant message was.
 *
 * Claude Code writes one event per line. Schema is duck-typed because
 * the official shape isn't documented as stable — fields we don't
 * recognize are ignored.
 */

import { promises as fs } from "node:fs";

interface TranscriptEvent {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Walk the transcript JSONL backwards and return the most recent USER
 * message text. Tool-result events (which also have `type: "user"`
 * but carry an array `content` of tool_result blocks) are skipped — we
 * only return user-typed plain-string utterances.
 *
 * Returns "" on any error or if no plain-string user message exists.
 */
export async function readLastUserText(transcriptPath: string): Promise<string> {
  const lines = await readTranscriptLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = safeParseLine(lines[i]);
    if (!event || event.type !== "user") continue;
    const content = event.message?.content;
    // Only accept plain string utterances. Tool-result events carry
    // an array `content` and aren't real user speech.
    if (typeof content === "string" && content.trim()) return content;
  }
  return "";
}

/**
 * Walk the transcript JSONL backwards and return the most recent
 * ASSISTANT message text. Concatenates text blocks if content is an
 * array of typed blocks.
 */
export async function readLastAssistantText(transcriptPath: string): Promise<string> {
  const lines = await readTranscriptLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = safeParseLine(lines[i]);
    if (!event || event.type !== "assistant") continue;
    const text = extractAssistantText(event);
    if (text) return text;
  }
  return "";
}

/**
 * v0.6.2 — find the most-recently-marked in_progress task id from the
 * transcript. Used by the pre-tool-use hook to figure out which task's
 * phase ledger to gate `git commit` against.
 *
 * Claude Code exposes three task-tracking surfaces; all are recognized:
 *
 * 1. **TodoWrite** (snapshot semantic) — `input.todos[]` is the full
 *    list with explicit ids + statuses. Each todo's status is applied
 *    at the snapshot's line index.
 *
 * 2. **TaskCreate** (delta) — `input.{subject,description,...}`. The
 *    assigned id comes back in the matching tool_result text
 *    ("Task #N created successfully"). Default status = pending.
 *    Active-task detection looks up tool_use_id → tool_result content.
 *
 * 3. **TaskUpdate** (delta) — `input.taskId` (string or number) +
 *    `input.status` ("in_progress"|"completed"|...). Direct mutation.
 *
 * Implementation: single forward pass over the transcript building a
 * `{task_id → {status, lastTouchedIdx}}` map. The forward pass means
 * chronology IS the sort key — latest write per id naturally wins,
 * no extra ordering logic needed. Returns the id with status =
 * "in_progress" and the highest lastTouchedIdx.
 *
 * v0.6.1 only recognized #1; my own session today used #2 + #3
 * exclusively, so the workflow gate silent-allowed every commit
 * (active task = null → no gate fires). This is the v0.6.2 fix.
 *
 * Returns null when no in_progress task is detected (graceful —
 * hook falls back to allow, per the fail-open invariant).
 */
/**
 * 0.7.9 (#163): how stale an `in_progress` task can be before it's
 * demoted as the active-task pick. Captures the "I forgot to mark
 * yesterday's task completed, but I'm working on a new one now"
 * scenario observed in #160's resume-drift investigation.
 */
const STALE_TASK_MS = 60 * 60 * 1000; // 1 hour

export async function readActiveTaskId(transcriptPath: string): Promise<string | null> {
  const lines = await readTranscriptLines(transcriptPath);

  // Walk forward, building per-id state from TaskCreate / TaskUpdate
  // events. TodoWrite (snapshot) is handled in a second pass after.
  // The lastTouchedIdx is the line position of the most recent event
  // that set this task's status — used to break ties between multiple
  // in_progress tasks (most-recently-touched wins).
  //
  // 0.7.9 (#163): also track lastTouchedAt (the event's wall-clock
  // timestamp) so we can demote stale `in_progress` tasks that the
  // agent forgot to mark completed long ago.
  interface TaskState {
    status: string;
    lastTouchedIdx: number;
    lastTouchedAt: number; // epoch ms; 0 if event had no timestamp
  }
  const stateByTask = new Map<string, TaskState>();
  let latestTimestampMs = 0;

  // Pre-index user events by tool_use_id so TaskCreate's id-extraction
  // doesn't N-squared scan. The tool_result block lives in a later
  // user event referencing the tool_use's id.
  const toolResultText = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const event = safeParseLine(lines[i]);
    if (!event || event.type !== "user") continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: string }).type !== "tool_result"
      ) {
        continue;
      }
      const tuId = (block as { tool_use_id?: unknown }).tool_use_id;
      const c = (block as { content?: unknown }).content;
      if (typeof tuId === "string" && typeof c === "string") {
        toolResultText.set(tuId, c);
      }
    }
  }

  // Single forward pass — chronological order is the line index, so
  // "latest write per id wins" is enforced naturally.
  for (let i = 0; i < lines.length; i++) {
    const event = safeParseLine(lines[i]);
    if (!event) continue;
    // 0.7.9 (#163): track the latest event timestamp across ANY event
    // type (not just assistant tool_use). Used to decide if the most
    // recent in_progress task pick is stale relative to current
    // session activity.
    const tsStr = (event as { timestamp?: unknown }).timestamp;
    if (typeof tsStr === "string") {
      const ms = Date.parse(tsStr);
      if (Number.isFinite(ms) && ms > latestTimestampMs) latestTimestampMs = ms;
    }
    if (event.type !== "assistant") continue;
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;

    // Capture this event's timestamp once for the task-touch logic
    // below.
    const eventTs = typeof tsStr === "string" ? Date.parse(tsStr) : Number.NaN;
    const eventTsMs = Number.isFinite(eventTs) ? eventTs : 0;

    for (const block of content) {
      if (!block || typeof block !== "object" || (block as { type?: string }).type !== "tool_use") {
        continue;
      }
      const name = (block as { name?: string }).name;
      const input = (block as { input?: unknown }).input;
      if (!input || typeof input !== "object") continue;

      if (name === "TaskUpdate") {
        const taskId = (input as { taskId?: unknown }).taskId;
        const status = (input as { status?: unknown }).status;
        const idStr =
          typeof taskId === "string" ? taskId : typeof taskId === "number" ? String(taskId) : "";
        if (idStr && typeof status === "string") {
          stateByTask.set(idStr, { status, lastTouchedIdx: i, lastTouchedAt: eventTsMs });
        }
      } else if (name === "TaskCreate") {
        // Extract assigned id from the matching tool_result. The regex
        // is intentionally loose — Claude Code's exact wording has
        // varied across versions ("Task #131 created", "Task 131 created",
        // future UUIDs?). We accept optional `#`, any word-char id.
        // If the wording changes more drastically, the regression test
        // against the real-transcript fixture will fail first instead
        // of the gate silently regressing in production.
        const blockId = (block as { id?: unknown }).id;
        if (typeof blockId !== "string") continue;
        const resultText = toolResultText.get(blockId);
        if (!resultText) continue;
        const m = resultText.match(/Task\s+#?([\w-]+)/i);
        if (m) {
          // Default status for newly-created tasks is "pending".
          stateByTask.set(m[1], { status: "pending", lastTouchedIdx: i, lastTouchedAt: eventTsMs });
        }
      } else if (name === "TodoWrite") {
        // Snapshot semantic — apply each todo's status at this chrono idx.
        // The list IS canonical for the ids it mentions, but only at
        // this point in time; a later TaskUpdate against the same id
        // would override (it'd happen at a higher idx, so naturally wins).
        const todos = (input as { todos?: unknown }).todos;
        if (!Array.isArray(todos)) continue;
        for (const todo of todos) {
          if (!todo || typeof todo !== "object") continue;
          const todoId = (todo as { id?: unknown }).id;
          const todoStatus = (todo as { status?: unknown }).status;
          const idStr =
            typeof todoId === "string" ? todoId : typeof todoId === "number" ? String(todoId) : "";
          if (idStr && typeof todoStatus === "string") {
            stateByTask.set(idStr, {
              status: todoStatus,
              lastTouchedIdx: i,
              lastTouchedAt: eventTsMs,
            });
          }
        }
      }
    }
  }

  // Find the most-recently-touched in_progress task. Ties broken by
  // higher line index = more recent.
  let bestId: string | null = null;
  let bestIdx = -1;
  let bestAt = 0;
  for (const [id, s] of stateByTask) {
    if (s.status === "in_progress" && s.lastTouchedIdx > bestIdx) {
      bestId = id;
      bestIdx = s.lastTouchedIdx;
      bestAt = s.lastTouchedAt;
    }
  }

  // 0.7.9 (#163): demote stale in_progress picks. If the best
  // in_progress task was last touched more than STALE_TASK_MS before
  // the latest transcript activity, assume the agent forgot to mark
  // it completed; return null so the workflow-gate doesn't enforce
  // against the wrong task. The fail-open invariant keeps the gate
  // permissive in this case — better than enforcing wrongly.
  //
  // Only applies when BOTH timestamps are available. If either is 0
  // (events lacked timestamps), fall back to the line-idx-based
  // pick like pre-0.7.9.
  if (bestId !== null && bestAt > 0 && latestTimestampMs > 0) {
    const ageMs = latestTimestampMs - bestAt;
    if (ageMs > STALE_TASK_MS) return null;
  }
  return bestId;
}

export async function readTranscriptLines(transcriptPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(transcriptPath, "utf8");
    return raw.split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

function safeParseLine(line: string): TranscriptEvent | null {
  try {
    return JSON.parse(line) as TranscriptEvent;
  } catch {
    return null;
  }
}

function extractAssistantText(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * Tests for `readActiveTaskId` — the transcript-walking helper that
 * finds the most-recent TodoWrite in_progress task id. Used by the
 * workflow gate to figure out which task's phase ledger to query.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { readActiveTaskId } from "./transcript.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let transcriptPath: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `opensquid-tx-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  transcriptPath = path.join(tmpDir, "transcript.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeEvents(events: unknown[]): Promise<void> {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.writeFile(transcriptPath, lines, "utf8");
}

function todoWriteEvent(todos: Array<{ id: string; status: string }>): unknown {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "TodoWrite",
          input: { todos },
        },
      ],
    },
  };
}

describe("readActiveTaskId", () => {
  it("returns null when transcript doesn't exist", async () => {
    expect(await readActiveTaskId(path.join(tmpDir, "missing.jsonl"))).toBeNull();
  });

  it("returns null when transcript is empty", async () => {
    await fs.writeFile(transcriptPath, "", "utf8");
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("returns null when no TodoWrite block exists", async () => {
    await writeEvents([
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", content: "hello" } },
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("returns null when TodoWrite has no in_progress items", async () => {
    await writeEvents([
      todoWriteEvent([
        { id: "1", status: "completed" },
        { id: "2", status: "pending" },
      ]),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("returns the in_progress task id from a single TodoWrite", async () => {
    await writeEvents([
      todoWriteEvent([
        { id: "1", status: "completed" },
        { id: "2", status: "in_progress" },
        { id: "3", status: "pending" },
      ]),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("2");
  });

  it("prefers the MOST RECENT TodoWrite when multiple exist", async () => {
    await writeEvents([
      todoWriteEvent([{ id: "old-task", status: "in_progress" }]),
      todoWriteEvent([{ id: "newer-task", status: "in_progress" }]),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("newer-task");
  });

  it("stops at the most-recent TodoWrite even if its in_progress is null", async () => {
    // The MOST RECENT TodoWrite has no in_progress (all completed).
    // We must NOT fall back to an OLDER TodoWrite's in_progress that
    // may have been overwritten. Returns null.
    await writeEvents([
      todoWriteEvent([{ id: "stale-task", status: "in_progress" }]),
      todoWriteEvent([
        { id: "stale-task", status: "completed" },
        { id: "all-done", status: "completed" },
      ]),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("ignores non-assistant events between TodoWrites", async () => {
    await writeEvents([
      { type: "user", message: { role: "user", content: "do thing" } },
      todoWriteEvent([{ id: "active", status: "in_progress" }]),
      { type: "user", message: { role: "user", content: "now go" } },
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("active");
  });

  it("ignores assistant text events without tool_use blocks", async () => {
    await writeEvents([
      todoWriteEvent([{ id: "real-active", status: "in_progress" }]),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "thinking..." }],
        },
      },
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("real-active");
  });

  it("ignores other tool_use events (Bash, Edit, etc.)", async () => {
    await writeEvents([
      todoWriteEvent([{ id: "active", status: "in_progress" }]),
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      },
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("active");
  });

  it("coerces numeric ids to strings", async () => {
    await writeEvents([
      todoWriteEvent([
        // Some serializations encode id as number.
        { id: 127 as unknown as string, status: "in_progress" },
      ]),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("127");
  });

  it("handles malformed JSON lines gracefully", async () => {
    await fs.writeFile(
      transcriptPath,
      [
        "{ malformed",
        JSON.stringify(todoWriteEvent([{ id: "active", status: "in_progress" }])),
        "still bad json",
      ].join("\n"),
      "utf8",
    );
    expect(await readActiveTaskId(transcriptPath)).toBe("active");
  });
});

// =====================================================================
// v0.6.2 — TaskCreate + TaskUpdate recognition (the real-world Claude
// Code shape; TodoWrite was the v0.6.1 shape). My own dogfood session
// today used TaskCreate/TaskUpdate exclusively → workflow gate silent-
// allowed every commit because readActiveTaskId only recognized
// TodoWrite. This block is the regression coverage for the fix.
// =====================================================================

function assistantToolUse(name: string, blockId: string, input: unknown): unknown {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: blockId,
          name,
          input,
          caller: { type: "direct" },
        },
      ],
    },
  };
}

function toolResult(toolUseId: string, content: string): unknown {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
  };
}

describe("readActiveTaskId — TaskUpdate (v0.6.2 fix)", () => {
  it("returns the taskId from TaskUpdate(status=in_progress)", async () => {
    await writeEvents([
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "131", status: "in_progress" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("131");
  });

  it("does not return tasks marked completed by a later TaskUpdate", async () => {
    await writeEvents([
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "131", status: "in_progress" }),
      assistantToolUse("TaskUpdate", "tu-2", { taskId: "131", status: "completed" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("picks the most-recently-touched in_progress task when multiple are active", async () => {
    await writeEvents([
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "100", status: "in_progress" }),
      assistantToolUse("TaskUpdate", "tu-2", { taskId: "200", status: "in_progress" }),
      assistantToolUse("TaskUpdate", "tu-3", { taskId: "300", status: "in_progress" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("300");
  });

  it("coerces numeric taskId to string", async () => {
    await writeEvents([
      assistantToolUse("TaskUpdate", "tu-1", { taskId: 131, status: "in_progress" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("131");
  });

  it("ignores TaskUpdate with deleted status", async () => {
    await writeEvents([
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "131", status: "in_progress" }),
      assistantToolUse("TaskUpdate", "tu-2", { taskId: "131", status: "deleted" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });
});

describe("readActiveTaskId — TaskCreate (v0.6.2 fix)", () => {
  it("does NOT return TaskCreate'd tasks (default status = pending, not in_progress)", async () => {
    // TaskCreate alone leaves the task as pending. Active-task detection
    // requires an explicit TaskUpdate(in_progress) — otherwise no gate
    // for tasks that were created but never started.
    await writeEvents([
      assistantToolUse("TaskCreate", "tc-1", {
        subject: "Some task",
        description: "...",
      }),
      toolResult("tc-1", "Task #131 created successfully: Some task"),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("returns the assigned id when TaskCreate is followed by TaskUpdate(in_progress)", async () => {
    await writeEvents([
      assistantToolUse("TaskCreate", "tc-1", { subject: "X", description: "..." }),
      toolResult("tc-1", "Task #131 created successfully: X"),
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "131", status: "in_progress" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("131");
  });

  it("handles TaskCreate without a matching tool_result (truncated transcript)", async () => {
    await writeEvents([
      assistantToolUse("TaskCreate", "tc-1", { subject: "X", description: "..." }),
      // No tool_result follows
    ]);
    // No id assigned, no in_progress → null.
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });
});

// =====================================================================
// Real-world fixture — captured from an actual Claude Code session.
// The fixture lives at __fixtures__/real-task-shape.jsonl. If Claude
// Code ever changes the wire format for TaskCreate / TaskUpdate, this
// test fails BEFORE the workflow gate silently regresses in
// production. Earlier audit recommendation (v0.6.2 audit MED): synthesized
// tests passed in v0.6.1 but real-world shape didn't match — the same
// failure mode would have been caught here.
// =====================================================================
describe("readActiveTaskId — real Claude Code transcript fixture", () => {
  it("recognizes TaskCreate + tool_result + TaskUpdate captured from a real session", async () => {
    const fixturePath = path.resolve(__dirname, "__fixtures__", "real-task-shape.jsonl");
    // The fixture is 3 events: TaskCreate "X" → tool_result "Task #1 created" →
    // TaskUpdate(taskId=1, status=in_progress). Expected active task: "1".
    const active = await readActiveTaskId(fixturePath);
    expect(active).toBe("1");
  });
});

// =====================================================================
// 0.7.9 (#163) — stale in_progress demotion
// =====================================================================

function assistantToolUseAt(
  name: string,
  blockId: string,
  input: unknown,
  timestamp: string,
): unknown {
  return {
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: blockId, name, input, caller: { type: "direct" } }],
    },
  };
}

function userEventAt(timestamp: string, text = "hello"): unknown {
  return { type: "user", timestamp, message: { role: "user", content: text } };
}

describe("readActiveTaskId — stale-task demotion (#163)", () => {
  const oldDay = "2026-05-16T08:00:00Z"; // ~24h before latest
  const today = "2026-05-17T08:00:00Z"; // latest activity

  it("returns null when the only in_progress task is >1hr stale relative to latest activity", async () => {
    await writeEvents([
      assistantToolUseAt("TaskUpdate", "tu-1", { taskId: "999", status: "in_progress" }, oldDay),
      // Many later events with newer timestamps — none touch task 999.
      userEventAt(today, "new conversation today"),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("keeps the in_progress task when it was recently touched", async () => {
    const recent = "2026-05-17T07:30:00Z"; // 30 min before latest
    await writeEvents([
      assistantToolUseAt("TaskUpdate", "tu-1", { taskId: "42", status: "in_progress" }, recent),
      userEventAt(today),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("42");
  });

  it("picks the more-recent in_progress when two exist (one stale, one fresh)", async () => {
    const recent = "2026-05-17T07:45:00Z";
    await writeEvents([
      assistantToolUseAt("TaskUpdate", "tu-1", { taskId: "X", status: "in_progress" }, oldDay),
      assistantToolUseAt("TaskUpdate", "tu-2", { taskId: "Y", status: "in_progress" }, recent),
      userEventAt(today),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("Y");
  });

  it("falls back to line-idx pick (no demotion) when events have no timestamps", async () => {
    // Pre-existing behavior preserved when timestamps aren't available.
    await writeEvents([
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "no-ts", status: "in_progress" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("no-ts");
  });
});

describe("readActiveTaskId — mixed TodoWrite + TaskUpdate", () => {
  it("latest write wins per id, regardless of which tool", async () => {
    // TodoWrite snapshot says id=5 is in_progress; later TaskUpdate
    // marks id=5 completed. TaskUpdate is later → wins.
    await writeEvents([
      todoWriteEvent([{ id: "5", status: "in_progress" }]),
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "5", status: "completed" }),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBeNull();
  });

  it("TodoWrite snapshot can revive an id that TaskUpdate marked completed if it comes later", async () => {
    await writeEvents([
      assistantToolUse("TaskUpdate", "tu-1", { taskId: "5", status: "completed" }),
      todoWriteEvent([{ id: "5", status: "in_progress" }]),
    ]);
    expect(await readActiveTaskId(transcriptPath)).toBe("5");
  });
});

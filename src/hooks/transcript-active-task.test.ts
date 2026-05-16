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

import { readActiveTaskId } from "./transcript.js";

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

/**
 * Pre-tool-use hook tests — focused on the #173 (drift D1) active-task
 * requirement check. Runs against a synthetic transcript file with
 * controllable TodoWrite shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkActiveTaskRequirement } from "./pre-tool-use.js";

let tmpDir: string;
let transcriptPath: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `opensquid-ptu-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  transcriptPath = path.join(tmpDir, "transcript.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeTranscriptWithActiveTask(taskId: string): Promise<void> {
  const event = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "TodoWrite",
          input: {
            todos: [{ id: taskId, status: "in_progress", content: "active thing" }],
          },
        },
      ],
    },
  };
  await fs.writeFile(transcriptPath, JSON.stringify(event) + "\n", "utf8");
}

describe("checkActiveTaskRequirement — #173 / drift D1 fix", () => {
  it("returns null for tools that aren't active-task-gated", async () => {
    const result = await checkActiveTaskRequirement(
      { tool: "Bash", input: { command: "ls" } },
      transcriptPath,
    );
    expect(result).toBeNull();
  });

  it("returns null when no transcript path is provided", async () => {
    const result = await checkActiveTaskRequirement(
      { tool: "mcp__opensquid__log_phase", input: {} },
      undefined,
    );
    expect(result).toBeNull();
  });

  it("returns null when an in_progress task exists in the transcript", async () => {
    await writeTranscriptWithActiveTask("42");
    const result = await checkActiveTaskRequirement(
      { tool: "mcp__opensquid__log_phase", input: { task_id: "42", phase: "code" } },
      transcriptPath,
    );
    expect(result).toBeNull();
  });

  it("returns a warning when log_phase is called with no in_progress task", async () => {
    await fs.writeFile(transcriptPath, "", "utf8"); // empty transcript = no tasks
    const result = await checkActiveTaskRequirement(
      { tool: "mcp__opensquid__log_phase", input: { task_id: "42", phase: "code" } },
      transcriptPath,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("mcp__opensquid__log_phase called without an in_progress");
    expect(result).toContain("TaskCreate");
  });

  it("returns a warning when chat_send is called with no in_progress task", async () => {
    await fs.writeFile(transcriptPath, "", "utf8");
    const result = await checkActiveTaskRequirement(
      { tool: "mcp__opensquid__chat_send", input: { channel: "telegram:1", text: "hi" } },
      transcriptPath,
    );
    expect(result).not.toBeNull();
    expect(result).toContain("mcp__opensquid__chat_send called without an in_progress");
  });

  it("emits the warning even when the transcript file is missing (readActiveTaskId returns null gracefully)", async () => {
    // readActiveTaskId handles missing files internally and returns
    // null. The D1 check treats null-active-task as "no in_progress
    // signal" regardless of cause, which is the right semantic — the
    // agent skipped TaskCreate is the failure mode either way.
    const result = await checkActiveTaskRequirement(
      { tool: "mcp__opensquid__log_phase", input: {} },
      path.join(tmpDir, "nonexistent.jsonl"),
    );
    expect(result).not.toBeNull();
    expect(result).toContain("called without an in_progress");
  });
});

/**
 * Workflow-gate tests — covers the pure evaluator (no engine subprocess
 * spawned). We mock the OpenSquidEngine.getTaskLedger to assert the
 * gate behavior without standing up a real engine binary. The hook
 * test wires the gate into the actual PreToolUse flow.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as engineClient from "../engine-client.js";

import { checkOverrideEnv, evaluateWorkflowGate } from "./workflow-gate.js";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

let tmpDir: string;
let transcriptPath: string;

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `opensquid-gate-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  transcriptPath = path.join(tmpDir, "transcript.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.OPENSQUID_SKIP_WORKFLOW_GATE;
  vi.restoreAllMocks();
});

async function writeTranscriptWithActiveTask(taskId: string): Promise<void> {
  // Single assistant tool_use event with a TodoWrite block. Matches
  // the shape readActiveTaskId scans for.
  const event = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "TodoWrite",
          input: {
            todos: [
              { id: "999", status: "completed", content: "done thing" },
              { id: taskId, status: "in_progress", content: "active thing" },
            ],
          },
        },
      ],
    },
  };
  await fs.writeFile(transcriptPath, JSON.stringify(event) + "\n", "utf8");
}

/** Mock OpenSquidEngine.getTaskLedger to return a specific phase set. */
function mockLedger(phasesLogged: string[]): void {
  vi.spyOn(engineClient.OpenSquidEngine.prototype, "getTaskLedger").mockResolvedValue({
    session_id: "test-session",
    task_id: "127",
    phases_logged: phasesLogged,
    entries: phasesLogged.map((p) => ({
      phase: p,
      logged_at: "2026-05-16T08:00:00.000Z",
      note: null,
    })),
  });
  // shutdown() is called in the finally block of evaluateWorkflowGate.
  vi.spyOn(engineClient.OpenSquidEngine.prototype, "shutdown").mockImplementation(() => {});
}

/** Mock the engine call to throw — simulates engine unreachable. */
function mockLedgerError(message: string): void {
  vi.spyOn(engineClient.OpenSquidEngine.prototype, "getTaskLedger").mockRejectedValue(
    new Error(message),
  );
  vi.spyOn(engineClient.OpenSquidEngine.prototype, "shutdown").mockImplementation(() => {});
}

// ---------------------------------------------------------------------
// Fail-open input scenarios — no block, no engine call
// ---------------------------------------------------------------------

describe("evaluateWorkflowGate — fail-open inputs", () => {
  it("returns allow when sessionId is missing", async () => {
    const result = await evaluateWorkflowGate({ transcriptPath });
    expect(result.block).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("returns allow with warning when transcriptPath is missing", async () => {
    const result = await evaluateWorkflowGate({ sessionId: "s1" });
    expect(result.block).toBe(false);
    expect(result.stderr).toContain("no transcript_path");
  });

  it("returns allow when transcript has no in_progress task", async () => {
    await fs.writeFile(transcriptPath, "", "utf8");
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("returns allow with warning when transcript path doesn't exist", async () => {
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath: path.join(tmpDir, "nonexistent.jsonl"),
    });
    expect(result.block).toBe(false);
    // readActiveTaskId swallows the read error → returns null → allow silently.
    expect(result.stderr).toBe("");
  });
});

// ---------------------------------------------------------------------
// Active task detected → engine RPC drives decision
// ---------------------------------------------------------------------

describe("evaluateWorkflowGate — with active task", () => {
  it("BLOCKS when audit + post_research are both missing", async () => {
    await writeTranscriptWithActiveTask("127");
    mockLedger(["code", "test"]);
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(true);
    expect(result.stderr).toContain("commit blocked");
    expect(result.stderr).toContain("audit, post_research");
    expect(result.stderr).toContain("127");
  });

  it("BLOCKS when only audit is missing", async () => {
    await writeTranscriptWithActiveTask("127");
    mockLedger(["code", "test", "post_research"]);
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(true);
    expect(result.stderr).toContain("missing phases: audit");
  });

  it("BLOCKS when only post_research is missing", async () => {
    await writeTranscriptWithActiveTask("127");
    mockLedger(["audit"]);
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(true);
    expect(result.stderr).toContain("missing phases: post_research");
  });

  it("ALLOWS when both required phases are logged", async () => {
    await writeTranscriptWithActiveTask("127");
    mockLedger(["audit", "post_research"]);
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(false);
    expect(result.stderr).toBe("");
  });

  it("ALLOWS when more than the required phases are logged (extra is fine)", async () => {
    await writeTranscriptWithActiveTask("127");
    mockLedger(["pre_research", "code", "audit", "post_research", "fix"]);
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Fail-open on engine error
// ---------------------------------------------------------------------

describe("evaluateWorkflowGate — fail-open invariant", () => {
  it("ALLOWS with stderr warning when engine RPC throws", async () => {
    await writeTranscriptWithActiveTask("127");
    mockLedgerError("ECONNREFUSED: engine not running");
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(false);
    expect(result.stderr).toContain("engine unreachable");
    expect(result.stderr).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------
// Emergency override
// ---------------------------------------------------------------------

describe("evaluateWorkflowGate — emergency override", () => {
  it("ALLOWS with bypass warning when OPENSQUID_SKIP_WORKFLOW_GATE=1", async () => {
    process.env.OPENSQUID_SKIP_WORKFLOW_GATE = "1";
    expect(checkOverrideEnv()).toBe(true);
    // Should bypass even if all the other signals say block.
    await writeTranscriptWithActiveTask("127");
    mockLedger(["code"]); // would otherwise block
    const result = await evaluateWorkflowGate({
      sessionId: "s1",
      transcriptPath,
    });
    expect(result.block).toBe(false);
    expect(result.stderr).toContain("BYPASSED");
  });

  it("respects the env var only when EXACTLY '1' (not 'true', not 'yes')", async () => {
    process.env.OPENSQUID_SKIP_WORKFLOW_GATE = "true";
    expect(checkOverrideEnv()).toBe(false);
    process.env.OPENSQUID_SKIP_WORKFLOW_GATE = "1";
    expect(checkOverrideEnv()).toBe(true);
  });
});

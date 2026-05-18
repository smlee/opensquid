/**
 * Tests for #124 — token-threshold heartbeat that replaces the auto-
 * classifier subprocess.
 */
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HEARTBEAT_TOKENS,
  checkAndMaybeArm,
  consumePendingHeartbeat,
  estimateTokens,
  estimateTranscriptTokens,
  formatHeartbeatNudge,
  heartbeatSessionFiles,
  heartbeatThresholdTokens,
  readCheckpoint,
  writeCheckpoint,
} from "./heartbeat.js";

let tmpRoot: string;
const SESSION = "heartbeat-test";

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-heartbeat-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
  // Ensure no env override leaks across tests.
  delete process.env.OPENSQUID_HEARTBEAT_TOKENS;
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.OPENSQUID_HEARTBEAT_TOKENS;
});

// ---------------------------------------------------------------------
// estimateTokens / heartbeatThresholdTokens
// ---------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty / null-ish input", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("approximates chars/4", () => {
    expect(estimateTokens("aaaa")).toBe(1);
    expect(estimateTokens("a".repeat(80))).toBe(20);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

describe("heartbeatThresholdTokens", () => {
  it("returns default when env unset", () => {
    expect(heartbeatThresholdTokens()).toBe(DEFAULT_HEARTBEAT_TOKENS);
  });

  it("honors OPENSQUID_HEARTBEAT_TOKENS positive integer", () => {
    process.env.OPENSQUID_HEARTBEAT_TOKENS = "5000";
    expect(heartbeatThresholdTokens()).toBe(5000);
  });

  it("falls back to default when env value is zero / negative / NaN", () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env.OPENSQUID_HEARTBEAT_TOKENS = bad;
      expect(heartbeatThresholdTokens()).toBe(DEFAULT_HEARTBEAT_TOKENS);
    }
  });
});

// ---------------------------------------------------------------------
// estimateTranscriptTokens
// ---------------------------------------------------------------------

describe("estimateTranscriptTokens (0.7.7 #161)", () => {
  it("returns 0 when transcript file is missing", async () => {
    const r = await estimateTranscriptTokens(path.join(tmpRoot, "nope.jsonl"));
    expect(r).toBe(0);
  });

  it("returns 0 for an empty file", async () => {
    const p = path.join(tmpRoot, "empty.jsonl");
    await fs.writeFile(p, "");
    expect(await estimateTranscriptTokens(p)).toBe(0);
  });

  it("counts user.string content", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(400) },
    });
    await fs.writeFile(p, line + "\n");
    // 400 chars / 4 = 100 tokens
    expect(await estimateTranscriptTokens(p)).toBe(100);
  });

  it("counts assistant text blocks", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(400) },
          { type: "text", text: "b".repeat(400) },
        ],
      },
    });
    await fs.writeFile(p, line + "\n");
    // 800 chars / 4 = 200 tokens
    expect(await estimateTranscriptTokens(p)).toBe(200);
  });

  it("SKIPS thinking blocks (agent internal CoT)", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "x".repeat(10000), signature: "sig" },
          { type: "text", text: "hello" },
        ],
      },
    });
    await fs.writeFile(p, line + "\n");
    // Only "hello" (5 chars) counted → 2 tokens (ceiling)
    expect(await estimateTranscriptTokens(p)).toBe(2);
  });

  it("SKIPS tool_use blocks (compact + outbound work)", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "after the tool" },
        ],
      },
    });
    await fs.writeFile(p, line + "\n");
    // Only the text block (14 chars) → 4 tokens
    expect(await estimateTranscriptTokens(p)).toBe(4);
  });

  it("CAPS tool_result content at 2000 chars (prevents tool-result inflation)", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: "z".repeat(50000), // huge file read
          },
        ],
      },
    });
    await fs.writeFile(p, line + "\n");
    // Capped at 2000 chars / 4 = 500 tokens (NOT 12,500)
    expect(await estimateTranscriptTokens(p)).toBe(500);
  });

  it("counts tool_result content array form (nested blocks)", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: [
              { type: "text", text: "y".repeat(800) },
              { type: "text", text: "y".repeat(800) },
            ],
          },
        ],
      },
    });
    await fs.writeFile(p, line + "\n");
    // 1600 chars total (under 2000 cap) → 400 tokens
    expect(await estimateTranscriptTokens(p)).toBe(400);
  });

  it("SKIPS non-conversation line types (system / permission-mode / file-history-snapshot / etc)", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const lines = [
      JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
      JSON.stringify({ type: "system", text: "x".repeat(10000) }),
      JSON.stringify({ type: "file-history-snapshot", snapshot: {} }),
      JSON.stringify({ type: "attachment", message: { content: "x".repeat(10000) } }),
      JSON.stringify({ type: "ai-title", title: "Hello" }),
      JSON.stringify({ type: "last-prompt", prompt: "x".repeat(10000) }),
    ].join("\n");
    await fs.writeFile(p, lines);
    expect(await estimateTranscriptTokens(p)).toBe(0);
  });

  it("tolerates malformed JSON lines (skips them)", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const lines = [
      "not json at all",
      JSON.stringify({ type: "user", message: { content: "hello" } }),
      "{partial json",
    ].join("\n");
    await fs.writeFile(p, lines);
    // Only "hello" counted (5 chars) → 2 tokens (ceiling)
    expect(await estimateTranscriptTokens(p)).toBe(2);
  });
});

// ---------------------------------------------------------------------
// formatHeartbeatNudge
// ---------------------------------------------------------------------

describe("formatHeartbeatNudge", () => {
  it("includes the delta + threshold + the recall instruction", () => {
    const nudge = formatHeartbeatNudge(20000, 20000);
    expect(nudge).toContain("20,000");
    expect(nudge).toContain("recall");
    expect(nudge).toContain("memorize");
    expect(nudge).toContain("🦑");
  });
});

// ---------------------------------------------------------------------
// Checkpoint IO
// ---------------------------------------------------------------------

describe("checkpoint IO", () => {
  it("returns null when no checkpoint file exists", async () => {
    expect(await readCheckpoint(SESSION, { dataRoot: tmpRoot })).toBeNull();
  });

  it("round-trips via writeCheckpoint", async () => {
    await writeCheckpoint(
      SESSION,
      { last_token_count: 12345, last_checkpoint_at: "2026-05-15T00:00:00Z" },
      { dataRoot: tmpRoot },
    );
    const back = await readCheckpoint(SESSION, { dataRoot: tmpRoot });
    expect(back?.last_token_count).toBe(12345);
    expect(back?.last_checkpoint_at).toBe("2026-05-15T00:00:00Z");
  });

  it("returns null on malformed JSON", async () => {
    const p = path.join(tmpRoot, "sessions", SESSION);
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(p, "heartbeat-checkpoint.json"), "not json");
    expect(await readCheckpoint(SESSION, { dataRoot: tmpRoot })).toBeNull();
  });
});

// ---------------------------------------------------------------------
// checkAndMaybeArm — Stop hook entrypoint
// ---------------------------------------------------------------------

describe("checkAndMaybeArm", () => {
  // 0.7.7 (#161): estimator now counts only user/assistant message bodies
  // from valid JSONL lines, not raw file bytes. Helper writes a synthetic
  // user message whose content has the requested char-count so existing
  // crossing-math tests still work without reading a real transcript.
  async function writeTranscript(chars: number): Promise<string> {
    const p = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(chars) },
    });
    await fs.writeFile(p, line + "\n");
    return p;
  }

  it("returns null when transcript is missing / empty", async () => {
    const r = await checkAndMaybeArm(SESSION, path.join(tmpRoot, "missing.jsonl"), {
      dataRoot: tmpRoot,
    });
    expect(r).toBeNull();
  });

  it("arms a heartbeat on first crossing (no prior checkpoint)", async () => {
    // 80000 chars -> 20000 tokens -> exactly threshold
    const tpath = await writeTranscript(80000);
    const nudge = await checkAndMaybeArm(SESSION, tpath, {
      dataRoot: tmpRoot,
      thresholdTokens: 20000,
    });
    expect(nudge).not.toBeNull();
    expect(nudge!).toContain("20,000");
    // Checkpoint bumped to the current count.
    const cp = await readCheckpoint(SESSION, { dataRoot: tmpRoot });
    expect(cp?.last_token_count).toBe(20000);
  });

  it("does NOT arm again until threshold crossed from the new checkpoint", async () => {
    // First crossing.
    let tpath = await writeTranscript(80000);
    expect(
      await checkAndMaybeArm(SESSION, tpath, { dataRoot: tmpRoot, thresholdTokens: 20000 }),
    ).not.toBeNull();

    // Drain the previous nudge so we can detect a fresh one (or its absence).
    await consumePendingHeartbeat(SESSION, { dataRoot: tmpRoot });

    // Transcript grows by less than threshold from the checkpoint.
    tpath = await writeTranscript(80000 + 4000); // +1000 tokens
    const second = await checkAndMaybeArm(SESSION, tpath, {
      dataRoot: tmpRoot,
      thresholdTokens: 20000,
    });
    expect(second).toBeNull();
    // Checkpoint stays at the first crossing.
    const cp = await readCheckpoint(SESSION, { dataRoot: tmpRoot });
    expect(cp?.last_token_count).toBe(20000);
  });

  it("resets stale baseline when checkpoint > 10x current (post-0.7.7 estimator migration)", async () => {
    // Simulate a checkpoint left by the old estimator: 31M tokens for a
    // 1.5M-token-real transcript. New estimator returns ~1.5M, baseline
    // says 31M → naive delta is negative → would never fire. Reset
    // logic must zero the baseline so the next crossing arms.
    await writeCheckpoint(
      SESSION,
      { last_token_count: 31_000_000, last_checkpoint_at: "2026-05-17T00:00:00Z" },
      { dataRoot: tmpRoot },
    );
    const tpath = await writeTranscript(80000); // 20K tokens
    const nudge = await checkAndMaybeArm(SESSION, tpath, {
      dataRoot: tmpRoot,
      thresholdTokens: 20000,
    });
    expect(nudge).not.toBeNull();
    const cp = await readCheckpoint(SESSION, { dataRoot: tmpRoot });
    expect(cp?.last_token_count).toBe(20000);
  });

  it("does NOT reset baseline when checkpoint is within reasonable range", async () => {
    // Baseline only 2x current — not stale, just slow growth (or
    // transcript shrunk via compaction). Don't reset.
    await writeCheckpoint(
      SESSION,
      { last_token_count: 40000, last_checkpoint_at: "2026-05-17T00:00:00Z" },
      { dataRoot: tmpRoot },
    );
    const tpath = await writeTranscript(80000); // 20K tokens, baseline 40K, delta = -20K
    const nudge = await checkAndMaybeArm(SESSION, tpath, {
      dataRoot: tmpRoot,
      thresholdTokens: 20000,
    });
    expect(nudge).toBeNull(); // negative delta, but no reset → no fire
  });

  it("arms again on each subsequent threshold crossing", async () => {
    // First crossing at 20K tokens.
    let tpath = await writeTranscript(80000);
    expect(
      await checkAndMaybeArm(SESSION, tpath, { dataRoot: tmpRoot, thresholdTokens: 20000 }),
    ).not.toBeNull();
    await consumePendingHeartbeat(SESSION, { dataRoot: tmpRoot });

    // Second crossing at 40K tokens.
    tpath = await writeTranscript(160000);
    expect(
      await checkAndMaybeArm(SESSION, tpath, { dataRoot: tmpRoot, thresholdTokens: 20000 }),
    ).not.toBeNull();
    const cp = await readCheckpoint(SESSION, { dataRoot: tmpRoot });
    expect(cp?.last_token_count).toBe(40000);
  });

  it("does not arm when below threshold and no prior checkpoint", async () => {
    const tpath = await writeTranscript(40000); // 10K tokens < 20K threshold
    const r = await checkAndMaybeArm(SESSION, tpath, {
      dataRoot: tmpRoot,
      thresholdTokens: 20000,
    });
    expect(r).toBeNull();
    // No checkpoint written when we didn't arm.
    expect(await readCheckpoint(SESSION, { dataRoot: tmpRoot })).toBeNull();
  });
});

// ---------------------------------------------------------------------
// consumePendingHeartbeat — UserPromptSubmit hook entrypoint
// ---------------------------------------------------------------------

describe("consumePendingHeartbeat", () => {
  it("returns null when no pending marker", async () => {
    expect(await consumePendingHeartbeat(SESSION, { dataRoot: tmpRoot })).toBeNull();
  });

  it("returns the armed nudge and removes the marker (one-shot)", async () => {
    // Arm. 0.7.7 (#161): estimator now requires valid JSONL; wrap the
    // body content so the line parses as a user message.
    const tpath = path.join(tmpRoot, "transcript.jsonl");
    const line = JSON.stringify({ type: "user", message: { content: "x".repeat(80000) } });
    await fs.writeFile(tpath, line + "\n");
    await checkAndMaybeArm(SESSION, tpath, { dataRoot: tmpRoot, thresholdTokens: 20000 });

    const first = await consumePendingHeartbeat(SESSION, { dataRoot: tmpRoot });
    expect(first).not.toBeNull();
    expect(first!).toContain("🦑");

    // Second consume returns null — marker was deleted.
    const second = await consumePendingHeartbeat(SESSION, { dataRoot: tmpRoot });
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------
// SessionEnd cleanup hook surface
// ---------------------------------------------------------------------

describe("heartbeatSessionFiles", () => {
  it("returns the two paths SessionEnd should remove", () => {
    const files = heartbeatSessionFiles(SESSION, tmpRoot);
    expect(files.some((p) => p.endsWith("heartbeat-checkpoint.json"))).toBe(true);
    expect(files.some((p) => p.endsWith("heartbeat-pending.txt"))).toBe(true);
  });
});

// =====================================================================
// 0.7.26 / D7 — recall-required flag (heartbeat → block until recall)
// =====================================================================

describe("recall-required flag (D7)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `opensquid-recall-flag-${crypto.randomUUID()}`);
    await fs.mkdir(tmp, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("isRecallRequired returns false when flag was never set", async () => {
    const { isRecallRequired } = await import("./heartbeat.js");
    expect(await isRecallRequired("sess-1", { dataRoot: tmp })).toBe(false);
  });

  it("markRecallRequired creates the flag; isRecallRequired returns true", async () => {
    const { markRecallRequired, isRecallRequired } = await import("./heartbeat.js");
    await markRecallRequired("sess-2", { dataRoot: tmp });
    expect(await isRecallRequired("sess-2", { dataRoot: tmp })).toBe(true);
  });

  it("clearRecallRequired removes the flag", async () => {
    const { markRecallRequired, clearRecallRequired, isRecallRequired } =
      await import("./heartbeat.js");
    await markRecallRequired("sess-3", { dataRoot: tmp });
    expect(await isRecallRequired("sess-3", { dataRoot: tmp })).toBe(true);
    await clearRecallRequired("sess-3", { dataRoot: tmp });
    expect(await isRecallRequired("sess-3", { dataRoot: tmp })).toBe(false);
  });

  it("clearRecallRequired is idempotent (clear without prior mark is fine)", async () => {
    const { clearRecallRequired } = await import("./heartbeat.js");
    await expect(clearRecallRequired("sess-never", { dataRoot: tmp })).resolves.toBeUndefined();
  });

  it("flags are per-session — setting one session doesn't affect another", async () => {
    const { markRecallRequired, isRecallRequired } = await import("./heartbeat.js");
    await markRecallRequired("sess-A", { dataRoot: tmp });
    expect(await isRecallRequired("sess-A", { dataRoot: tmp })).toBe(true);
    expect(await isRecallRequired("sess-B", { dataRoot: tmp })).toBe(false);
  });

  it("heartbeatSessionFiles includes the recall-required flag path for SessionEnd cleanup", async () => {
    const { heartbeatSessionFiles } = await import("./heartbeat.js");
    const files = heartbeatSessionFiles("sess-1", tmp);
    expect(files.some((p) => p.endsWith("recall-required.flag"))).toBe(true);
  });
});

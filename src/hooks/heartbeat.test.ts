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

describe("estimateTranscriptTokens", () => {
  it("returns 0 when transcript file is missing", async () => {
    const r = await estimateTranscriptTokens(path.join(tmpRoot, "nope.jsonl"));
    expect(r).toBe(0);
  });

  it("estimates tokens from raw file bytes", async () => {
    const p = path.join(tmpRoot, "transcript.jsonl");
    // 4000 chars -> ~1000 tokens
    await fs.writeFile(p, "x".repeat(4000));
    const r = await estimateTranscriptTokens(p);
    expect(r).toBe(1000);
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
  async function writeTranscript(chars: number): Promise<string> {
    const p = path.join(tmpRoot, "transcript.jsonl");
    await fs.writeFile(p, "x".repeat(chars));
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
    // Arm.
    const tpath = path.join(tmpRoot, "transcript.jsonl");
    await fs.writeFile(tpath, "x".repeat(80000));
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

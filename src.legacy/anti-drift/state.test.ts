/**
 * Tests for anti-drift/state.ts (0.8 unified-evaluator track foundation).
 *
 * Each test uses a fresh tmpdir as dataRoot to keep tests hermetic.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendViolation,
  clearActiveTask,
  consumeViolations,
  driftCatalogPath,
  readActiveTask,
  sessionStateFiles,
  writeActiveTask,
  type ActiveTaskState,
  type ViolationEntry,
} from "./state.js";

const SESSION = "test-session-xyz";
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anti-drift-state-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("active-task state", () => {
  it("readActiveTask returns null when no file exists", async () => {
    expect(await readActiveTask(SESSION, { dataRoot: tmp })).toBeNull();
  });

  it("writeActiveTask + readActiveTask round-trips", async () => {
    const state: ActiveTaskState = {
      id: "11",
      subject: "scaffold anti-drift/state.ts",
      started_at: "2026-05-18T15:00:00.000Z",
    };
    await writeActiveTask(SESSION, state, { dataRoot: tmp });
    const got = await readActiveTask(SESSION, { dataRoot: tmp });
    expect(got).toEqual(state);
  });

  it("writeActiveTask is overwrite (idempotent for TaskUpdate semantics)", async () => {
    await writeActiveTask(
      SESSION,
      { id: "11", subject: "first", started_at: "2026-05-18T15:00:00.000Z" },
      { dataRoot: tmp },
    );
    await writeActiveTask(
      SESSION,
      { id: "11", subject: "updated", started_at: "2026-05-18T15:01:00.000Z" },
      { dataRoot: tmp },
    );
    const got = await readActiveTask(SESSION, { dataRoot: tmp });
    expect(got?.subject).toBe("updated");
  });

  it("clearActiveTask removes the file", async () => {
    await writeActiveTask(
      SESSION,
      { id: "11", started_at: "2026-05-18T15:00:00.000Z" },
      { dataRoot: tmp },
    );
    expect(await readActiveTask(SESSION, { dataRoot: tmp })).not.toBeNull();
    await clearActiveTask(SESSION, { dataRoot: tmp });
    expect(await readActiveTask(SESSION, { dataRoot: tmp })).toBeNull();
  });

  it("clearActiveTask is idempotent (no error when file absent)", async () => {
    await expect(clearActiveTask(SESSION, { dataRoot: tmp })).resolves.toBeUndefined();
  });

  it("readActiveTask returns null on malformed JSON (fail-safe)", async () => {
    const dir = path.join(tmp, "sessions", SESSION);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "active-task.json"), "not valid json {", "utf8");
    expect(await readActiveTask(SESSION, { dataRoot: tmp })).toBeNull();
  });

  it("readActiveTask returns null on missing required fields", async () => {
    const dir = path.join(tmp, "sessions", SESSION);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "active-task.json"), '{"subject":"no id field"}', "utf8");
    expect(await readActiveTask(SESSION, { dataRoot: tmp })).toBeNull();
  });
});

describe("violations.log", () => {
  it("consumeViolations returns empty array when no file exists", async () => {
    expect(await consumeViolations(SESSION, { dataRoot: tmp })).toEqual([]);
  });

  it("appendViolation + consumeViolations round-trips a single entry", async () => {
    const entry: ViolationEntry = {
      ts: "2026-05-18T15:05:00.000Z",
      rule_id: "active-task-required",
      verdict: "block",
      reason: "log_phase called without an in_progress task",
    };
    await appendViolation(SESSION, entry, { dataRoot: tmp });
    expect(await consumeViolations(SESSION, { dataRoot: tmp })).toEqual([entry]);
  });

  it("consumeViolations clears the file (atomic claim)", async () => {
    await appendViolation(
      SESSION,
      { ts: "1", rule_id: "x", verdict: "block", reason: "y" },
      { dataRoot: tmp },
    );
    const first = await consumeViolations(SESSION, { dataRoot: tmp });
    expect(first.length).toBe(1);
    // Second consume on now-empty state returns empty.
    expect(await consumeViolations(SESSION, { dataRoot: tmp })).toEqual([]);
  });

  it("multiple appends accumulate", async () => {
    await appendViolation(
      SESSION,
      { ts: "1", rule_id: "a", verdict: "block", reason: "r1" },
      { dataRoot: tmp },
    );
    await appendViolation(
      SESSION,
      { ts: "2", rule_id: "b", verdict: "warn", reason: "r2" },
      { dataRoot: tmp },
    );
    const got = await consumeViolations(SESSION, { dataRoot: tmp });
    expect(got.length).toBe(2);
    expect(got.map((e) => e.rule_id)).toEqual(["a", "b"]);
  });

  it("consumeViolations skips malformed lines silently", async () => {
    const dir = path.join(tmp, "sessions", SESSION);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "violations.log"),
      `not json\n${JSON.stringify({ ts: "1", rule_id: "ok", verdict: "warn", reason: "real" })}\n`,
      "utf8",
    );
    const got = await consumeViolations(SESSION, { dataRoot: tmp });
    expect(got).toHaveLength(1);
    expect(got[0].rule_id).toBe("ok");
  });
});

describe("driftCatalogPath", () => {
  it("uses project-scoped path when projectUuid is provided", () => {
    const got = driftCatalogPath("abc-uuid", SESSION, tmp);
    expect(got).toBe(path.join(tmp, "projects", "abc-uuid", "drift-catalog.jsonl"));
  });

  it("falls back to session-scoped path when projectUuid is null", () => {
    const got = driftCatalogPath(null, SESSION, tmp);
    expect(got).toBe(path.join(tmp, "sessions", SESSION, "drift-catalog.jsonl"));
  });
});

describe("sessionStateFiles", () => {
  it("returns the per-session state file paths for SessionEnd cleanup", () => {
    const got = sessionStateFiles(SESSION, tmp);
    expect(got).toContain(path.join(tmp, "sessions", SESSION, "active-task.json"));
    expect(got).toContain(path.join(tmp, "sessions", SESSION, "violations.log"));
    expect(got).toHaveLength(2);
  });

  it("does NOT include project-scoped paths (drift-catalog.jsonl is durable across sessions)", () => {
    const got = sessionStateFiles(SESSION, tmp);
    expect(got.every((p) => !p.includes("/projects/"))).toBe(true);
    expect(got.every((p) => !p.endsWith("drift-catalog.jsonl"))).toBe(true);
  });
});

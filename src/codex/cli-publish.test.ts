/**
 * Tests for #116 — codex-install auto-publish to CLAUDE.md.
 *
 * Covers `publishSeededLessonToClaudeMd` directly so we don't need a
 * real engine subprocess to verify the auto-publish behavior.
 */
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { publishSeededLessonToClaudeMd } from "./cli.js";

let tmpDir: string;
let claudeMdPath: string;

const INSTALLED_BLOCK = [
  "# CLAUDE.md",
  "",
  "<!-- opensquid-automation:start v0.4.0 -->",
  "Some opensquid automation guidance lives here.",
  "",
  "<!-- opensquid-rules:start (auto-managed) -->",
  "(no promoted lessons yet — this block populates as `lesson.promote`",
  "succeeds for user-endorsed candidates)",
  "<!-- opensquid-rules:end -->",
  "<!-- opensquid-automation:end -->",
  "",
].join("\n");

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `opensquid-publish-test-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  claudeMdPath = path.join(tmpDir, "CLAUDE.md");
  await fs.writeFile(claudeMdPath, INSTALLED_BLOCK, "utf8");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("publishSeededLessonToClaudeMd", () => {
  it("appends a new line into the rules block", async () => {
    const appended = await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-abc12345",
        description: "before doing X (codex:test-codex)",
        createdAt: "2026-05-15T22:00:00Z",
        codexLessonId: "do-x",
      },
      { target: claudeMdPath },
    );
    expect(appended).toBe(true);
    const content = await fs.readFile(claudeMdPath, "utf8");
    expect(content).toContain("(lesson:les-abc12345)");
    expect(content).toContain("before doing X (codex:test-codex)");
    expect(content).toContain("promoted 2026-05-15T22:00:00Z");
    // Placeholder line should be gone.
    expect(content).not.toContain("(no promoted lessons yet");
  });

  it("is idempotent — second call with same id is a no-op", async () => {
    const first = await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-dup",
        description: "x",
        createdAt: "2026-05-15T22:00:00Z",
        codexLessonId: "x",
      },
      { target: claudeMdPath },
    );
    expect(first).toBe(true);
    const second = await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-dup",
        description: "x",
        createdAt: "2026-05-15T22:01:00Z",
        codexLessonId: "x",
      },
      { target: claudeMdPath },
    );
    expect(second).toBe(false);
    const content = await fs.readFile(claudeMdPath, "utf8");
    const matches = content.match(/\(lesson:les-dup\)/g);
    expect(matches?.length).toBe(1);
  });

  it("appends multiple distinct lesson ids in order", async () => {
    await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-1",
        description: "first",
        createdAt: "2026-05-15T22:00:00Z",
        codexLessonId: "a",
      },
      { target: claudeMdPath },
    );
    await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-2",
        description: "second",
        createdAt: "2026-05-15T22:00:01Z",
        codexLessonId: "b",
      },
      { target: claudeMdPath },
    );
    await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-3",
        description: "third",
        createdAt: "2026-05-15T22:00:02Z",
        codexLessonId: "c",
      },
      { target: claudeMdPath },
    );
    const content = await fs.readFile(claudeMdPath, "utf8");
    const idx1 = content.indexOf("first");
    const idx2 = content.indexOf("second");
    const idx3 = content.indexOf("third");
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
  });

  it("returns false when engineLessonId is undefined", async () => {
    const appended = await publishSeededLessonToClaudeMd(
      {
        engineLessonId: undefined,
        description: "no id",
        createdAt: "2026-05-15T22:00:00Z",
        codexLessonId: "no-id",
      },
      { target: claudeMdPath },
    );
    expect(appended).toBe(false);
    const content = await fs.readFile(claudeMdPath, "utf8");
    expect(content).toContain("(no promoted lessons yet");
  });

  it("returns false (silent no-op) when CLAUDE.md is missing", async () => {
    const appended = await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-orphan",
        description: "orphan",
        createdAt: "2026-05-15T22:00:00Z",
        codexLessonId: "orphan",
      },
      { target: path.join(tmpDir, "does-not-exist.md") },
    );
    expect(appended).toBe(false);
  });

  it("returns false when CLAUDE.md exists but has no rules block", async () => {
    const noBlockPath = path.join(tmpDir, "no-block.md");
    await fs.writeFile(noBlockPath, "# CLAUDE.md\n\nNo opensquid block here.\n", "utf8");
    const appended = await publishSeededLessonToClaudeMd(
      {
        engineLessonId: "les-orphan2",
        description: "orphan2",
        createdAt: "2026-05-15T22:00:00Z",
        codexLessonId: "orphan2",
      },
      { target: noBlockPath },
    );
    expect(appended).toBe(false);
    // Original file is untouched.
    const content = await fs.readFile(noBlockPath, "utf8");
    expect(content).toBe("# CLAUDE.md\n\nNo opensquid block here.\n");
  });
});

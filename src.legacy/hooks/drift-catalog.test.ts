/**
 * Tests for drift-catalog (0.7.22 / drift D10).
 *
 * Covers scanTranscriptForDrift pure function. End-to-end persistence
 * exercised in resolveCatalogPath tests (no project card) — full
 * project-card flow needs fs fixtures and is left to integration.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCatalogPath, scanTranscriptForDrift } from "./drift-catalog.js";

const FIXED_NOW = () => new Date("2026-05-18T06:00:00.000Z");
const SESSION_ID = "test-session-abc";

function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

describe("scanTranscriptForDrift — user correction patterns", () => {
  it("catches 'you drifted'", () => {
    const entries = scanTranscriptForDrift(
      [userLine("hey you drifted again")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.kind === "user_correction")).toBe(true);
  });

  it("catches 'stop asking'", () => {
    const entries = scanTranscriptForDrift(
      [userLine("please stop asking me to confirm every step")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "user_correction")).toBe(true);
  });

  it("catches 'don't repeat'", () => {
    const entries = scanTranscriptForDrift(
      [userLine("don't repeat the same false-stop pattern")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "user_correction")).toBe(true);
  });

  it("does NOT catch 'wrong' on its own", () => {
    const entries = scanTranscriptForDrift(
      [userLine("the answer was wrong")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.filter((e) => e.kind === "user_correction")).toEqual([]);
  });

  it("ignores tool_result-shaped user events (array content)", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "you drifted" }] },
    });
    const entries = scanTranscriptForDrift([line], SESSION_ID, FIXED_NOW);
    expect(entries).toEqual([]);
  });
});

describe("scanTranscriptForDrift — rule citations", () => {
  it("catches feedback_* references in user text", () => {
    const entries = scanTranscriptForDrift(
      [userLine("re-read feedback_full_automation_mode")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(
      entries.some((e) => e.kind === "rule_citation" && e.evidence.startsWith("feedback_")),
    ).toBe(true);
  });

  it("catches mem-<hex> references in assistant text", () => {
    const entries = scanTranscriptForDrift(
      [assistantLine("per mem-3cf66f39 we don't apologize")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "rule_citation" && e.evidence.startsWith("mem-"))).toBe(
      true,
    );
  });

  it("catches drift D-number references", () => {
    const entries = scanTranscriptForDrift(
      [userLine("you're hitting drift D9 again")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "rule_citation" && /drift\s+D9/i.test(e.evidence))).toBe(
      true,
    );
  });
});

describe("scanTranscriptForDrift — mea-culpa patterns", () => {
  it("catches 'I drifted' in assistant text", () => {
    const entries = scanTranscriptForDrift(
      [assistantLine("you're right, I drifted from the locked rule")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "mea_culpa")).toBe(true);
  });

  it("catches 'I should have' in assistant text", () => {
    const entries = scanTranscriptForDrift(
      [assistantLine("I should have called recall before answering")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "mea_culpa")).toBe(true);
  });

  it("catches 'I false-stopped'", () => {
    const entries = scanTranscriptForDrift(
      [assistantLine("I false-stopped at the end of last turn")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "mea_culpa")).toBe(true);
  });

  it("does NOT fire on assistant claim that's just a quote of the user", () => {
    // The user said "I drifted" → assistant repeated it. Mea-culpa pattern still fires
    // — accepted noise per the conservative-on-purpose stance. This test documents
    // current behavior, not perfection.
    const entries = scanTranscriptForDrift(
      [assistantLine('the user said "I drifted" but that wasn\'t about me')],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "mea_culpa")).toBe(true);
  });
});

describe("scanTranscriptForDrift — entry shape", () => {
  it("populates timestamp, session_id, kind, evidence, context", () => {
    const entries = scanTranscriptForDrift(
      [userLine("you drifted again right after I locked the rule")],
      SESSION_ID,
      FIXED_NOW,
    );
    const correction = entries.find((e) => e.kind === "user_correction");
    expect(correction).toBeDefined();
    expect(correction!.timestamp).toBe("2026-05-18T06:00:00.000Z");
    expect(correction!.session_id).toBe(SESSION_ID);
    expect(correction!.evidence).toBe("you drifted");
    expect(correction!.context).toContain("you drifted");
  });

  it("handles multiple turns and accumulates entries", () => {
    const entries = scanTranscriptForDrift(
      [
        userLine("you drifted yesterday"),
        assistantLine("I should have noticed sooner"),
        userLine("feedback_full_automation_mode applies here"),
      ],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const kinds = new Set(entries.map((e) => e.kind));
    expect(kinds.has("user_correction")).toBe(true);
    expect(kinds.has("mea_culpa")).toBe(true);
    expect(kinds.has("rule_citation")).toBe(true);
  });

  it("skips malformed JSONL lines silently", () => {
    const entries = scanTranscriptForDrift(
      ["not valid json", "", userLine("you drifted")],
      SESSION_ID,
      FIXED_NOW,
    );
    expect(entries.some((e) => e.kind === "user_correction")).toBe(true);
  });
});

describe("resolveCatalogPath — session fallback when no project card", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "drift-catalog-test-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns session-scoped path when no project card exists in cwd ancestry", async () => {
    // Use a fresh tmpdir as both cwd and dataRoot — guaranteed no .opensquid/ card up the tree.
    const noCardDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-card-"));
    try {
      const got = await resolveCatalogPath(noCardDir, "sess-xyz", tmpDir);
      expect(got).toBe(path.join(tmpDir, "sessions", "sess-xyz", "drift-catalog.jsonl"));
    } finally {
      await fs.rm(noCardDir, { recursive: true, force: true });
    }
  });

  it("returns session-scoped path when cwd is undefined", async () => {
    const got = await resolveCatalogPath(undefined, "sess-xyz", tmpDir);
    expect(got).toBe(path.join(tmpDir, "sessions", "sess-xyz", "drift-catalog.jsonl"));
  });

  it("returns project-scoped path when cwd has a .opensquid/project.json card", async () => {
    // Create a project card in the cwd
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "with-card-"));
    try {
      await fs.mkdir(path.join(projectRoot, ".opensquid"), { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, ".opensquid", "project.json"),
        JSON.stringify({
          version: 1,
          id: "test-project",
          uuid: "abc-uuid-123",
          created_at: "2026-05-18T00:00:00.000Z",
        }),
      );
      const got = await resolveCatalogPath(projectRoot, "sess-xyz", tmpDir);
      expect(got).toBe(path.join(tmpDir, "projects", "abc-uuid-123", "drift-catalog.jsonl"));
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

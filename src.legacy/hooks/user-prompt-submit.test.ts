/**
 * Tests for UserPromptSubmit hook helpers — focused on the resume-
 * detection logic added in 0.7.10 (#164).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectMultiTaskDirective,
  detectResumeAndUpdateMarker,
  extractTaskRefs,
} from "./user-prompt-submit.js";

let tmpRoot: string;
const SESSION = "test-session";

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-ups-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("detectResumeAndUpdateMarker (#164)", () => {
  it("returns null on first firing (no marker yet) but creates the marker", async () => {
    const now = Date.parse("2026-05-17T10:00:00Z");
    const msg = await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now });
    expect(msg).toBeNull();
    // Marker should exist with current timestamp.
    const written = await fs.readFile(
      path.join(tmpRoot, "sessions", SESSION, "ups-last-at.txt"),
      "utf8",
    );
    expect(written.trim()).toBe(new Date(now).toISOString());
  });

  it("returns null when gap < 5 minutes (continuous session)", async () => {
    const first = Date.parse("2026-05-17T10:00:00Z");
    await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: first });
    const second = first + 60 * 1000; // 1 minute later
    const msg = await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: second });
    expect(msg).toBeNull();
  });

  it("returns a resume message when gap >= 5 minutes", async () => {
    const first = Date.parse("2026-05-17T10:00:00Z");
    await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: first });
    const second = first + 6 * 60 * 1000; // 6 minutes later
    const msg = await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: second });
    expect(msg).not.toBeNull();
    expect(msg!).toContain("Session resumed");
    expect(msg!).toContain("6m");
    expect(msg!).toContain("re-anchor");
    expect(msg!).toContain("recall");
  });

  it("returns a resume message after a long gap (hours)", async () => {
    const first = Date.parse("2026-05-17T00:00:00Z");
    await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: first });
    const second = first + 8 * 60 * 60 * 1000; // 8 hours later
    const msg = await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: second });
    expect(msg).not.toBeNull();
    expect(msg!).toContain("480m"); // 8h * 60min
  });

  it("updates the marker on every firing (so next gap is measured from the most-recent)", async () => {
    const t0 = Date.parse("2026-05-17T10:00:00Z");
    await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: t0 });
    const t1 = t0 + 60_000;
    await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: t1 });
    const written = await fs.readFile(
      path.join(tmpRoot, "sessions", SESSION, "ups-last-at.txt"),
      "utf8",
    );
    expect(written.trim()).toBe(new Date(t1).toISOString());
  });

  it("returns null at exactly the 5-minute boundary (just under)", async () => {
    const first = Date.parse("2026-05-17T10:00:00Z");
    await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: first });
    const second = first + 5 * 60 * 1000 - 1; // 4m59.999s
    const msg = await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now: second });
    expect(msg).toBeNull();
  });

  it("tolerates a corrupt marker file (returns null, overwrites)", async () => {
    const dir = path.join(tmpRoot, "sessions", SESSION);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "ups-last-at.txt"), "not a date", "utf8");
    const now = Date.parse("2026-05-17T10:00:00Z");
    const msg = await detectResumeAndUpdateMarker(SESSION, { dataRoot: tmpRoot, now });
    expect(msg).toBeNull();
    // Should still have written the new timestamp.
    const written = await fs.readFile(path.join(dir, "ups-last-at.txt"), "utf8");
    expect(written.trim()).toBe(new Date(now).toISOString());
  });

  it("isolates per-session (gap on session A doesn't affect session B)", async () => {
    const t0 = Date.parse("2026-05-17T10:00:00Z");
    await detectResumeAndUpdateMarker("A", { dataRoot: tmpRoot, now: t0 });
    // Session B's first firing 6h later — still its FIRST firing, so null.
    const tLater = t0 + 6 * 60 * 60 * 1000;
    const msgB = await detectResumeAndUpdateMarker("B", { dataRoot: tmpRoot, now: tLater });
    expect(msgB).toBeNull();
  });
});

describe("detectMultiTaskDirective — D8 (0.7.27)", () => {
  it("fires on '166 then 168' (bare-number sequencing — D8 incident shape)", () => {
    const m = detectMultiTaskDirective("166 then 168");
    expect(m).not.toBeNull();
    expect(m).toContain("#166");
    expect(m).toContain("#168");
  });

  it("fires on '#171 then #172' (explicit references)", () => {
    expect(detectMultiTaskDirective("#171 then #172")).not.toBeNull();
  });

  it("fires on '166, 168' comma-separated", () => {
    expect(detectMultiTaskDirective("166, 168")).not.toBeNull();
  });

  it("does NOT fire on a single task reference", () => {
    expect(detectMultiTaskDirective("work on #170")).toBeNull();
    expect(detectMultiTaskDirective("can you do 168")).toBeNull();
  });

  it("does NOT fire on unrelated number prose", () => {
    // No sequencing connector → no D8 risk.
    expect(detectMultiTaskDirective("we shipped 5 patches in 30 minutes")).toBeNull();
  });

  it("extractTaskRefs returns refs in document order", () => {
    expect(extractTaskRefs("166 then 168")).toEqual(["#166", "#168"]);
    expect(extractTaskRefs("#171 and #172")).toEqual(["#171", "#172"]);
  });

  it("extractTaskRefs dedupes references", () => {
    expect(extractTaskRefs("#170 then #170")).toEqual(["#170"]);
  });
});

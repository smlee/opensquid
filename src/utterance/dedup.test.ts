import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isSemanticallyDuplicate,
  loadSessionHashes,
  recordSessionHash,
  utteranceFingerprint,
} from "./dedup.js";

let tmpRoot: string;
const SESSION = "dedup-test";

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `oscli-dedup-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("utteranceFingerprint", () => {
  it("is stable for identical inputs", () => {
    const a = utteranceFingerprint({
      kind: "fact",
      text: "I use pnpm",
      suggested_tool: "memorize",
    });
    const b = utteranceFingerprint({
      kind: "fact",
      text: "I use pnpm",
      suggested_tool: "memorize",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    const a = utteranceFingerprint({
      kind: "fact",
      text: "I use pnpm",
      suggested_tool: "memorize",
    });
    const b = utteranceFingerprint({
      kind: "fact",
      text: "i  use   PNPM",
      suggested_tool: "memorize",
    });
    expect(a).toBe(b);
  });

  it("differs when kind changes", () => {
    const a = utteranceFingerprint({
      kind: "fact",
      text: "I use pnpm",
      suggested_tool: "memorize",
    });
    const b = utteranceFingerprint({
      kind: "preference",
      text: "I use pnpm",
      suggested_tool: "memorize",
    });
    expect(a).not.toBe(b);
  });

  it("differs when suggested_tool changes", () => {
    const a = utteranceFingerprint({
      kind: "fact",
      text: "x",
      suggested_tool: "memorize",
    });
    const b = utteranceFingerprint({
      kind: "fact",
      text: "x",
      suggested_tool: "remember",
    });
    expect(a).not.toBe(b);
  });
});

describe("session hash IO", () => {
  it("loadSessionHashes returns empty Set when no file exists", async () => {
    const r = await loadSessionHashes(SESSION, { dataRoot: tmpRoot });
    expect(r.size).toBe(0);
  });

  it("recordSessionHash + loadSessionHashes roundtrip", async () => {
    await recordSessionHash(SESSION, "abc123", { dataRoot: tmpRoot });
    await recordSessionHash(SESSION, "def456", { dataRoot: tmpRoot });
    const r = await loadSessionHashes(SESSION, { dataRoot: tmpRoot });
    expect(r.size).toBe(2);
    expect(r.has("abc123")).toBe(true);
    expect(r.has("def456")).toBe(true);
  });

  it("recordSessionHash dedupes via the loaded Set (caller responsibility)", async () => {
    // The file IS append-only (writes the same fingerprint twice); the
    // Set semantics dedup on load.
    await recordSessionHash(SESSION, "abc123", { dataRoot: tmpRoot });
    await recordSessionHash(SESSION, "abc123", { dataRoot: tmpRoot });
    const r = await loadSessionHashes(SESSION, { dataRoot: tmpRoot });
    expect(r.size).toBe(1);
  });

  it("does not crash if hash record fails (best-effort)", async () => {
    // Pass a dataRoot that's actually a file, so mkdir under it fails.
    const blocked = path.join(tmpRoot, "blocker");
    await fs.writeFile(blocked, "i am a file");
    // Should not throw.
    await expect(recordSessionHash(SESSION, "abc", { dataRoot: blocked })).resolves.toBeUndefined();
  });
});

describe("isSemanticallyDuplicate", () => {
  it("returns true when a high-similarity hit exists", async () => {
    const r = await isSemanticallyDuplicate("user prefers pnpm", async () => ({
      results: [{ score: 0.92, source: "semantic" }],
    }));
    expect(r).toBe(true);
  });

  it("returns true on 'source: both' even when score is borderline", async () => {
    const r = await isSemanticallyDuplicate("user prefers pnpm", async () => ({
      results: [{ score: 0.5, source: "both" }],
    }));
    expect(r).toBe(true);
  });

  it("returns false when all hits are below threshold and not both-source", async () => {
    const r = await isSemanticallyDuplicate("user prefers pnpm", async () => ({
      results: [
        { score: 0.4, source: "semantic" },
        { score: 0.6, source: "text" },
      ],
    }));
    expect(r).toBe(false);
  });

  it("returns false when results are empty", async () => {
    const r = await isSemanticallyDuplicate("user prefers pnpm", async () => ({ results: [] }));
    expect(r).toBe(false);
  });

  it("returns false (fail-open) when searchMemory throws", async () => {
    const r = await isSemanticallyDuplicate("user prefers pnpm", async () => {
      throw new Error("engine down");
    });
    expect(r).toBe(false);
  });

  it("respects custom minSimilarity threshold", async () => {
    const r = await isSemanticallyDuplicate(
      "user prefers pnpm",
      async () => ({ results: [{ score: 0.7, source: "semantic" }] }),
      { minSimilarity: 0.95, bothBoost: false },
    );
    expect(r).toBe(false);
  });
});

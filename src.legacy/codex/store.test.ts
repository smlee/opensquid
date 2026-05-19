import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodexStoreError,
  codexContentPath,
  codexDir,
  codexesDir,
  getCodex,
  installCodex,
  listCodexes,
  removeCodex,
  resolveDataRoot,
  validateCodexId,
} from "./store.js";
import type { Codex, FocusedCodex } from "./types.js";

// ---------------------------------------------------------------------
// Per-test temp directory isolation
// ---------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `opensquid-codex-test-${crypto.randomUUID()}`);
  await fs.mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// Test fixtures
function focused(id: string): FocusedCodex {
  return {
    id,
    version: "1.0.0",
    foundation: { methodologies: ["tdd"] },
    detected_by: [{ kind: "user_pinned" }],
    activation_scope: "user",
  };
}

// ---------------------------------------------------------------------
// resolveDataRoot
// ---------------------------------------------------------------------

describe("resolveDataRoot", () => {
  const origOpenSquid = process.env.OPENSQUID_HOME;
  const origLoop = process.env.LOOP_HOME;

  afterEach(() => {
    if (origOpenSquid === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = origOpenSquid;
    if (origLoop === undefined) delete process.env.LOOP_HOME;
    else process.env.LOOP_HOME = origLoop;
  });

  it("prefers explicit rootDir over everything else", () => {
    process.env.OPENSQUID_HOME = "/from-env";
    expect(resolveDataRoot("/explicit")).toBe("/explicit");
  });

  it("uses OPENSQUID_HOME when no explicit rootDir", () => {
    process.env.OPENSQUID_HOME = "/from-os-home";
    process.env.LOOP_HOME = "/from-loop-home";
    expect(resolveDataRoot()).toBe("/from-os-home");
  });

  it("falls back to LOOP_HOME", () => {
    delete process.env.OPENSQUID_HOME;
    process.env.LOOP_HOME = "/from-loop-home";
    expect(resolveDataRoot()).toBe("/from-loop-home");
  });

  it("defaults to ~/.opensquid when no env set", () => {
    delete process.env.OPENSQUID_HOME;
    delete process.env.LOOP_HOME;
    expect(resolveDataRoot()).toBe(path.join(os.homedir(), ".opensquid"));
  });
});

// ---------------------------------------------------------------------
// validateCodexId
// ---------------------------------------------------------------------

describe("validateCodexId", () => {
  it("accepts standard ids", () => {
    expect(() => validateCodexId("react-19")).not.toThrow();
    expect(() => validateCodexId("fullstack-react-atomic")).not.toThrow();
    expect(() => validateCodexId("scanpy.v1")).not.toThrow();
    expect(() => validateCodexId("a")).not.toThrow();
    expect(() => validateCodexId("123tools")).not.toThrow();
  });

  it("rejects path traversal attempts", () => {
    expect(() => validateCodexId("../escape")).toThrow(CodexStoreError);
    expect(() => validateCodexId("a/b")).toThrow(CodexStoreError);
    expect(() => validateCodexId("a\\b")).toThrow(CodexStoreError);
  });

  it("rejects uppercase", () => {
    expect(() => validateCodexId("React-19")).toThrow(CodexStoreError);
  });

  it("rejects empty + dot/dash leading", () => {
    expect(() => validateCodexId("")).toThrow(CodexStoreError);
    expect(() => validateCodexId(".hidden")).toThrow(CodexStoreError);
    expect(() => validateCodexId("-leading")).toThrow(CodexStoreError);
  });

  it("rejects >128 chars", () => {
    expect(() => validateCodexId("a".repeat(129))).toThrow(CodexStoreError);
  });
});

// ---------------------------------------------------------------------
// installCodex / getCodex round-trip
// ---------------------------------------------------------------------

describe("installCodex + getCodex round-trip", () => {
  it("installs and retrieves a focused codex", async () => {
    const c = focused("react-19");
    const res = await installCodex(c, { rootDir: tmpRoot });
    expect(res.id).toBe("react-19");
    expect(res.path).toBe(codexDir("react-19", tmpRoot));

    const loaded = await getCodex("react-19", { rootDir: tmpRoot });
    expect(loaded.id).toBe("react-19");
    expect(loaded.version).toBe("1.0.0");
  });

  it("creates the codex directory + codex.yaml manifest", async () => {
    await installCodex(focused("x"), { rootDir: tmpRoot });
    const manifest = path.join(codexDir("x", tmpRoot), "codex.yaml");
    const stat = await fs.stat(manifest);
    expect(stat.isFile()).toBe(true);
  });

  it("throws ALREADY_INSTALLED on re-install without force", async () => {
    await installCodex(focused("x"), { rootDir: tmpRoot });
    await expect(installCodex(focused("x"), { rootDir: tmpRoot })).rejects.toMatchObject({
      code: "ALREADY_INSTALLED",
    });
  });

  it("overwrites with force=true", async () => {
    const v1 = focused("x");
    v1.version = "1.0.0";
    await installCodex(v1, { rootDir: tmpRoot });
    const v2 = focused("x");
    v2.version = "2.0.0";
    await installCodex(v2, { rootDir: tmpRoot, force: true });
    const loaded = await getCodex("x", { rootDir: tmpRoot });
    expect(loaded.version).toBe("2.0.0");
  });

  it("installs composite codex", async () => {
    const composite: Codex = {
      id: "fullstack",
      kind: "composite",
      version: "1.0.0",
      includes: [
        { id: "react", semver: ">=18" },
        { id: "tdd", semver: ">=1" },
      ],
    };
    await installCodex(composite, { rootDir: tmpRoot });
    const loaded = await getCodex("fullstack", { rootDir: tmpRoot });
    expect(loaded.kind).toBe("composite");
  });

  it("rejects invalid codex id at install", async () => {
    const bad = focused("Bad-Id");
    await expect(installCodex(bad, { rootDir: tmpRoot })).rejects.toMatchObject({
      code: "INVALID_ID",
    });
  });
});

// ---------------------------------------------------------------------
// getCodex error paths
// ---------------------------------------------------------------------

describe("getCodex error paths", () => {
  it("throws NOT_FOUND when codex is not installed", async () => {
    await expect(getCodex("ghost", { rootDir: tmpRoot })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws PARSE_FAILED on malformed manifest", async () => {
    const dir = codexDir("malformed", tmpRoot);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "codex.yaml"), "id: x\n  bad: indentation: here", "utf8");
    await expect(getCodex("malformed", { rootDir: tmpRoot })).rejects.toMatchObject({
      code: "PARSE_FAILED",
    });
  });

  it("throws INVALID_ID for path-escaping ids", async () => {
    await expect(getCodex("../escape", { rootDir: tmpRoot })).rejects.toMatchObject({
      code: "INVALID_ID",
    });
  });
});

// ---------------------------------------------------------------------
// listCodexes
// ---------------------------------------------------------------------

describe("listCodexes", () => {
  it("returns [] when codexes/ dir doesn't exist", async () => {
    expect(await listCodexes({ rootDir: tmpRoot })).toEqual([]);
  });

  it("returns sorted list of installed ids", async () => {
    await installCodex(focused("zebra"), { rootDir: tmpRoot });
    await installCodex(focused("apple"), { rootDir: tmpRoot });
    await installCodex(focused("mango"), { rootDir: tmpRoot });
    expect(await listCodexes({ rootDir: tmpRoot })).toEqual(["apple", "mango", "zebra"]);
  });

  it("skips directories without codex.yaml (partial installs)", async () => {
    await installCodex(focused("complete"), { rootDir: tmpRoot });
    // Create a stray directory without a manifest.
    await fs.mkdir(path.join(codexesDir(tmpRoot), "partial"), {
      recursive: true,
    });
    expect(await listCodexes({ rootDir: tmpRoot })).toEqual(["complete"]);
  });

  it("skips directories with invalid id syntax", async () => {
    await installCodex(focused("valid"), { rootDir: tmpRoot });
    await fs.mkdir(path.join(codexesDir(tmpRoot), "Bad-Id"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(codexesDir(tmpRoot), "Bad-Id", "codex.yaml"),
      "id: Bad-Id\nversion: 1.0.0\n",
      "utf8",
    );
    expect(await listCodexes({ rootDir: tmpRoot })).toEqual(["valid"]);
  });
});

// ---------------------------------------------------------------------
// removeCodex
// ---------------------------------------------------------------------

describe("removeCodex", () => {
  it("removes an installed codex, returns true", async () => {
    await installCodex(focused("doomed"), { rootDir: tmpRoot });
    expect(await removeCodex("doomed", { rootDir: tmpRoot })).toBe(true);
    await expect(getCodex("doomed", { rootDir: tmpRoot })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns false when codex is not installed (idempotent)", async () => {
    expect(await removeCodex("ghost", { rootDir: tmpRoot })).toBe(false);
  });

  it("recursively removes lesson bodies + companion files", async () => {
    await installCodex(focused("with-content"), { rootDir: tmpRoot });
    const lessonDir = path.join(codexDir("with-content", tmpRoot), "lessons", "l1");
    await fs.mkdir(lessonDir, { recursive: true });
    await fs.writeFile(path.join(lessonDir, "lesson.md"), "# lesson", "utf8");
    await removeCodex("with-content", { rootDir: tmpRoot });
    await expect(fs.access(lessonDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------
// codexContentPath
// ---------------------------------------------------------------------

describe("codexContentPath", () => {
  it("resolves a content path inside the codex", () => {
    const p = codexContentPath("react-19", "lessons/x/lesson.md", {
      rootDir: tmpRoot,
    });
    expect(p).toBe(path.join(codexDir("react-19", tmpRoot), "lessons", "x", "lesson.md"));
  });

  it("rejects path traversal in the relative path", () => {
    expect(() =>
      codexContentPath("react-19", "../../../etc/passwd", {
        rootDir: tmpRoot,
      }),
    ).toThrow(CodexStoreError);
  });

  it("rejects invalid codex id", () => {
    expect(() => codexContentPath("../escape", "lesson.md", { rootDir: tmpRoot })).toThrow(
      CodexStoreError,
    );
  });
});

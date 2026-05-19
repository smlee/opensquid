import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CodexActivationCache,
  evaluateDetection,
  extractCodexId,
  isCodexActive,
} from "./activate.js";
import { installCodex } from "./store.js";
import type { Codex, FocusedCodex } from "./types.js";

let tmpCwd: string;
let tmpStore: string;

beforeEach(async () => {
  const uniq = crypto.randomUUID();
  tmpCwd = path.join(os.tmpdir(), `oscli-activate-cwd-${uniq}`);
  tmpStore = path.join(os.tmpdir(), `oscli-activate-store-${uniq}`);
  await fs.mkdir(tmpCwd, { recursive: true });
  await fs.mkdir(tmpStore, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpCwd, { recursive: true, force: true });
  await fs.rm(tmpStore, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// extractCodexId
// ---------------------------------------------------------------------

describe("extractCodexId", () => {
  it("extracts id from codex-suffixed description", () => {
    expect(extractCodexId("before any push (codex:loop-engineering-workflow)")).toBe(
      "loop-engineering-workflow",
    );
  });

  it("trims trailing whitespace tolerantly", () => {
    expect(extractCodexId("rule (codex:x)  ")).toBe("x");
  });

  it("returns null when no suffix", () => {
    expect(extractCodexId("some legacy lesson description")).toBeNull();
  });

  it("returns null for non-id-shaped content in parens", () => {
    expect(extractCodexId("see (PR #42)")).toBeNull();
    expect(extractCodexId("see (codex:Bad-Id)")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// evaluateDetection — filesystem signals
// ---------------------------------------------------------------------

describe("evaluateDetection: file_exists", () => {
  it("matches when file present", async () => {
    await fs.writeFile(path.join(tmpCwd, "package.json"), "{}", "utf8");
    expect(await evaluateDetection({ kind: "file_exists", path: "package.json" }, tmpCwd)).toBe(
      true,
    );
  });

  it("misses when file absent", async () => {
    expect(await evaluateDetection({ kind: "file_exists", path: "package.json" }, tmpCwd)).toBe(
      false,
    );
  });

  it("misses when path is a directory", async () => {
    await fs.mkdir(path.join(tmpCwd, "package.json"));
    expect(await evaluateDetection({ kind: "file_exists", path: "package.json" }, tmpCwd)).toBe(
      false,
    );
  });
});

describe("evaluateDetection: dir_exists", () => {
  it("matches when dir present", async () => {
    await fs.mkdir(path.join(tmpCwd, "src/components/atoms"), { recursive: true });
    expect(
      await evaluateDetection({ kind: "dir_exists", path: "src/components/atoms" }, tmpCwd),
    ).toBe(true);
  });

  it("misses when dir absent", async () => {
    expect(
      await evaluateDetection({ kind: "dir_exists", path: "src/components/atoms" }, tmpCwd),
    ).toBe(false);
  });
});

describe("evaluateDetection: file_match (JSON)", () => {
  it("matches when dotted path resolves to a truthy value", async () => {
    await fs.writeFile(
      path.join(tmpCwd, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
      "utf8",
    );
    expect(
      await evaluateDetection(
        {
          kind: "file_match",
          path: "package.json",
          matches: { "dependencies.react": ">=19" },
        },
        tmpCwd,
      ),
    ).toBe(true);
  });

  it("misses when dotted path is missing", async () => {
    await fs.writeFile(path.join(tmpCwd, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    expect(
      await evaluateDetection(
        {
          kind: "file_match",
          path: "package.json",
          matches: { "dependencies.react": ">=19" },
        },
        tmpCwd,
      ),
    ).toBe(false);
  });

  it("misses when file is absent", async () => {
    expect(
      await evaluateDetection(
        {
          kind: "file_match",
          path: "package.json",
          matches: { "dependencies.react": ">=19" },
        },
        tmpCwd,
      ),
    ).toBe(false);
  });
});

describe("evaluateDetection: file_glob", () => {
  it("matches when min_count met", async () => {
    await fs.mkdir(path.join(tmpCwd, "data"));
    await fs.writeFile(path.join(tmpCwd, "data/sample1.h5ad"), "", "utf8");
    await fs.writeFile(path.join(tmpCwd, "data/sample2.h5ad"), "", "utf8");
    expect(
      await evaluateDetection({ kind: "file_glob", pattern: "**/*.h5ad", min_count: 2 }, tmpCwd),
    ).toBe(true);
  });

  it("misses when below min_count", async () => {
    await fs.mkdir(path.join(tmpCwd, "data"));
    await fs.writeFile(path.join(tmpCwd, "data/sample1.h5ad"), "", "utf8");
    expect(
      await evaluateDetection({ kind: "file_glob", pattern: "**/*.h5ad", min_count: 2 }, tmpCwd),
    ).toBe(false);
  });

  it("skips node_modules + dot-dirs during walk", async () => {
    await fs.mkdir(path.join(tmpCwd, "node_modules/foo"), { recursive: true });
    await fs.mkdir(path.join(tmpCwd, ".git"), { recursive: true });
    await fs.writeFile(path.join(tmpCwd, "node_modules/foo/x.h5ad"), "", "utf8");
    await fs.writeFile(path.join(tmpCwd, ".git/x.h5ad"), "", "utf8");
    expect(
      await evaluateDetection({ kind: "file_glob", pattern: "**/*.h5ad", min_count: 1 }, tmpCwd),
    ).toBe(false);
  });
});

describe("evaluateDetection: user_pinned", () => {
  it("always returns true", async () => {
    expect(await evaluateDetection({ kind: "user_pinned" }, tmpCwd)).toBe(true);
  });
});

describe("evaluateDetection: all_of / any_of", () => {
  it("all_of requires every condition", async () => {
    await fs.writeFile(path.join(tmpCwd, "a"), "", "utf8");
    expect(
      await evaluateDetection(
        {
          kind: "all_of",
          conditions: [
            { kind: "file_exists", path: "a" },
            { kind: "file_exists", path: "b" },
          ],
        },
        tmpCwd,
      ),
    ).toBe(false);
    await fs.writeFile(path.join(tmpCwd, "b"), "", "utf8");
    expect(
      await evaluateDetection(
        {
          kind: "all_of",
          conditions: [
            { kind: "file_exists", path: "a" },
            { kind: "file_exists", path: "b" },
          ],
        },
        tmpCwd,
      ),
    ).toBe(true);
  });

  it("any_of accepts any single match", async () => {
    await fs.writeFile(path.join(tmpCwd, "a"), "", "utf8");
    expect(
      await evaluateDetection(
        {
          kind: "any_of",
          conditions: [
            { kind: "file_exists", path: "a" },
            { kind: "file_exists", path: "b" },
          ],
        },
        tmpCwd,
      ),
    ).toBe(true);
  });
});

describe("evaluateDetection: memory_match / conversation_signal", () => {
  it("memory_match defaults to true (runtime context not available here)", async () => {
    expect(
      await evaluateDetection(
        { kind: "memory_match", memory_kind: "profession", value: "clinician" },
        tmpCwd,
      ),
    ).toBe(true);
  });

  it("conversation_signal defaults to true", async () => {
    expect(
      await evaluateDetection({ kind: "conversation_signal", contains: ["case law"] }, tmpCwd),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------
// isCodexActive
// ---------------------------------------------------------------------

describe("isCodexActive", () => {
  function focused(detected_by: FocusedCodex["detected_by"] | undefined): FocusedCodex {
    return {
      id: "test",
      version: "1.0.0",
      detected_by,
    };
  }

  it("composite codexes are inactive (includes activate via their own detected_by)", async () => {
    const composite: Codex = {
      id: "x",
      kind: "composite",
      version: "1.0.0",
      includes: [{ id: "a", semver: ">=1" }],
    };
    expect(await isCodexActive(composite, tmpCwd)).toBe(false);
  });

  it("focused codex with no detected_by defaults to active", async () => {
    expect(await isCodexActive(focused(undefined), tmpCwd)).toBe(true);
    expect(await isCodexActive(focused([]), tmpCwd)).toBe(true);
  });

  it("top-level detected_by list = OR semantics", async () => {
    await fs.writeFile(path.join(tmpCwd, "tsconfig.json"), "{}", "utf8");
    expect(
      await isCodexActive(
        focused([
          { kind: "file_exists", path: "Cargo.toml" }, // miss
          { kind: "file_exists", path: "tsconfig.json" }, // hit
        ]),
        tmpCwd,
      ),
    ).toBe(true);
  });

  it("no matching detection → inactive", async () => {
    expect(
      await isCodexActive(focused([{ kind: "file_exists", path: "Cargo.toml" }]), tmpCwd),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// CodexActivationCache
// ---------------------------------------------------------------------

describe("CodexActivationCache", () => {
  it("returns true for an installed user_pinned codex", async () => {
    const codex: Codex = {
      id: "wf",
      version: "1.0.0",
      activation_scope: "user",
      detected_by: [{ kind: "user_pinned" }],
    };
    await installCodex(codex, { rootDir: tmpStore });
    const cache = new CodexActivationCache(tmpCwd, tmpStore);
    expect(await cache.isActive("wf")).toBe(true);
  });

  it("returns false when detected_by doesn't match cwd", async () => {
    const codex: Codex = {
      id: "react-19",
      version: "1.0.0",
      detected_by: [{ kind: "file_exists", path: "package.json" }],
    };
    await installCodex(codex, { rootDir: tmpStore });
    const cache = new CodexActivationCache(tmpCwd, tmpStore);
    expect(await cache.isActive("react-19")).toBe(false);
  });

  it("returns false for non-installed codex (stale lesson reference)", async () => {
    const cache = new CodexActivationCache(tmpCwd, tmpStore);
    expect(await cache.isActive("ghost-codex")).toBe(false);
  });

  it("caches the same decision across repeated lookups", async () => {
    const codex: Codex = {
      id: "wf",
      version: "1.0.0",
      detected_by: [{ kind: "user_pinned" }],
    };
    await installCodex(codex, { rootDir: tmpStore });
    const cache = new CodexActivationCache(tmpCwd, tmpStore);
    const a = await cache.isActive("wf");
    const b = await cache.isActive("wf");
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});

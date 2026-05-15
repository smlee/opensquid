import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexCliError, runCodexCli } from "./cli.js";
import { codexDir, codexesDir } from "./store.js";

// ---------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------

let tmpRoot: string;
let sourceRoot: string;
const origConsoleLog = console.log;
const origConsoleError = console.error;

beforeEach(async () => {
  const uniq = crypto.randomUUID();
  tmpRoot = path.join(os.tmpdir(), `opensquid-cli-test-${uniq}`);
  sourceRoot = path.join(os.tmpdir(), `opensquid-cli-src-${uniq}`);
  await fs.mkdir(tmpRoot, { recursive: true });
  await fs.mkdir(sourceRoot, { recursive: true });
  // Silence console during tests.
  console.log = () => {};
  console.error = () => {};
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await fs.rm(sourceRoot, { recursive: true, force: true });
  console.log = origConsoleLog;
  console.error = origConsoleError;
});

// Fixture: write a minimal valid codex YAML + lesson body at sourceRoot.
async function makeSourceCodex(opts?: { withLessonBody?: boolean }): Promise<void> {
  const yaml = `
id: react-19
version: 1.0.0
foundation:
  tools:
    - { name: react, semver: ">=19,<20" }
  domains: [software-engineering]
detected_by:
  - { kind: file_exists, path: "package.json" }
seed_lessons:
  - id: atomic-search
    trigger: "before creating a component"
    bank_strategy: full
    body_path: "lessons/atomic-search/lesson.md"
`;
  await fs.writeFile(path.join(sourceRoot, "codex.yaml"), yaml, "utf8");
  if (opts?.withLessonBody) {
    const lessonDir = path.join(sourceRoot, "lessons", "atomic-search");
    await fs.mkdir(lessonDir, { recursive: true });
    await fs.writeFile(
      path.join(lessonDir, "lesson.md"),
      "# Atomic search\n\nSearch atoms/molecules/organisms first.\n",
      "utf8",
    );
  }
}

async function makeCompositeSource(): Promise<void> {
  const yaml = `
id: fullstack-bundle
kind: composite
version: 1.0.0
includes:
  - { id: react, semver: ">=18" }
  - { id: tdd, semver: ">=1" }
`;
  await fs.writeFile(path.join(sourceRoot, "codex.yaml"), yaml, "utf8");
}

// ---------------------------------------------------------------------
// install
// ---------------------------------------------------------------------

describe("runCodexCli install", () => {
  it("installs a focused codex from a local directory", async () => {
    await makeSourceCodex({ withLessonBody: true });
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    const manifest = path.join(codexDir("react-19", tmpRoot), "codex.yaml");
    expect((await fs.stat(manifest)).isFile()).toBe(true);
  });

  it("copies lesson bodies + companion files into canonical location", async () => {
    await makeSourceCodex({ withLessonBody: true });
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    const lessonBody = path.join(
      codexDir("react-19", tmpRoot),
      "lessons",
      "atomic-search",
      "lesson.md",
    );
    expect((await fs.stat(lessonBody)).isFile()).toBe(true);
    const content = await fs.readFile(lessonBody, "utf8");
    expect(content).toContain("Atomic search");
  });

  it("installs a composite codex (no content copy)", async () => {
    await makeCompositeSource();
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    const dir = codexDir("fullstack-bundle", tmpRoot);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(["codex.yaml"]);
  });

  it("accepts an explicit codex.yaml path (not just the dir)", async () => {
    await makeSourceCodex();
    const explicitFile = path.join(sourceRoot, "codex.yaml");
    await runCodexCli("install", [explicitFile, "--root", tmpRoot, "--no-seed"]);
    expect((await fs.stat(path.join(codexDir("react-19", tmpRoot), "codex.yaml"))).isFile()).toBe(
      true,
    );
  });

  it("throws when source path doesn't exist", async () => {
    await expect(runCodexCli("install", ["/nonexistent/path", "--root", tmpRoot])).rejects.toThrow(
      CodexCliError,
    );
  });

  it("throws when codex.yaml is missing from source dir", async () => {
    await expect(runCodexCli("install", [sourceRoot, "--root", tmpRoot])).rejects.toThrow(
      CodexCliError,
    );
  });

  it("throws on malformed codex.yaml", async () => {
    await fs.writeFile(
      path.join(sourceRoot, "codex.yaml"),
      "id: bad-id-uppercase\nNOT_A: VALID_FIELD\n",
      "utf8",
    );
    await expect(runCodexCli("install", [sourceRoot, "--root", tmpRoot])).rejects.toThrow(
      CodexCliError,
    );
  });

  it("respects --force on re-install", async () => {
    await makeSourceCodex();
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    // Second install without --force throws ALREADY_INSTALLED.
    await expect(runCodexCli("install", [sourceRoot, "--root", tmpRoot])).rejects.toThrow();
    // With --force succeeds.
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--force", "--no-seed"]);
  });

  it("rejects missing source arg", async () => {
    await expect(runCodexCli("install", ["--root", tmpRoot])).rejects.toThrow(CodexCliError);
  });
});

// ---------------------------------------------------------------------
// list
// ---------------------------------------------------------------------

describe("runCodexCli list", () => {
  it("succeeds on empty root", async () => {
    await runCodexCli("list", ["--root", tmpRoot]);
  });

  it("succeeds when codexes are installed", async () => {
    await makeSourceCodex();
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    await runCodexCli("list", ["--root", tmpRoot]);
  });
});

// ---------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------

describe("runCodexCli remove", () => {
  it("removes an installed codex", async () => {
    await makeSourceCodex();
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    await runCodexCli("remove", ["react-19", "--root", tmpRoot]);
    await expect(fs.access(codexDir("react-19", tmpRoot))).rejects.toThrow();
  });

  it("is idempotent on missing codex", async () => {
    // No throw — just no-op.
    await runCodexCli("remove", ["ghost", "--root", tmpRoot]);
  });

  it("rejects missing id arg", async () => {
    await expect(runCodexCli("remove", ["--root", tmpRoot])).rejects.toThrow(CodexCliError);
  });
});

// ---------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------

describe("runCodexCli doctor", () => {
  it("reports empty state", async () => {
    await runCodexCli("doctor", ["--root", tmpRoot]);
  });

  it("reports per-codex detail when id is passed", async () => {
    await makeSourceCodex();
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    await runCodexCli("doctor", ["react-19", "--root", tmpRoot]);
  });

  it("reports gracefully on missing codex when id is passed", async () => {
    await runCodexCli("doctor", ["ghost", "--root", tmpRoot]);
  });
});

// ---------------------------------------------------------------------
// flag parsing
// ---------------------------------------------------------------------

describe("flag parsing", () => {
  it("honors --root override", async () => {
    await makeSourceCodex();
    await runCodexCli("install", [sourceRoot, "--root", tmpRoot, "--no-seed"]);
    // Codex should be in tmpRoot, NOT in the user's actual ~/.opensquid.
    expect((await fs.stat(codexesDir(tmpRoot))).isDirectory()).toBe(true);
  });
});

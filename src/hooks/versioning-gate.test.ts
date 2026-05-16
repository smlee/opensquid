/**
 * Versioning-gate tests — exercise against real git repos in tmpdirs.
 * The gate's logic depends on actual `git diff --cached` output shape,
 * so synthesized state wouldn't catch the same class of bug that
 * v0.6.1 transcript-walker missed against real Claude Code shapes
 * (per the v0.6.2 lesson). Each test inits a fresh tmp git repo,
 * sets up the staged state we want, runs the gate, asserts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkOverrideEnv,
  evaluateVersioningGate,
  isManifestFile,
  isSourceFile,
} from "./versioning-gate.js";

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

let repoDir: string;

beforeEach(async () => {
  repoDir = path.join(os.tmpdir(), `opensquid-ver-${crypto.randomUUID()}`);
  await fs.mkdir(repoDir, { recursive: true });
  // Minimal git init that doesn't depend on the user's global config.
  execSync("git init -q", { cwd: repoDir });
  execSync("git config user.email test@example.com", { cwd: repoDir });
  execSync("git config user.name 'Test'", { cwd: repoDir });
});

afterEach(async () => {
  await fs.rm(repoDir, { recursive: true, force: true });
  delete process.env.OPENSQUID_SKIP_VERSION_GATE;
});

async function writeFile(rel: string, content: string): Promise<void> {
  const full = path.join(repoDir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
}

function stage(rel: string): void {
  execSync(`git add ${rel}`, { cwd: repoDir });
}

function commit(message: string): void {
  execSync(`git commit -q -m '${message}'`, { cwd: repoDir });
}

/** Initial commit so subsequent `git diff --cached` against HEAD works. */
async function seedInitial(): Promise<void> {
  await writeFile("README.md", "# seed\n");
  stage("README.md");
  commit("initial");
}

// ---------------------------------------------------------------------
// Pure helper tests (no git involvement)
// ---------------------------------------------------------------------

describe("isSourceFile", () => {
  it("matches src/ at repo root", () => {
    expect(isSourceFile("src/index.ts")).toBe(true);
    expect(isSourceFile("src/hooks/foo.ts")).toBe(true);
  });
  it("matches nested src/ in workspace member", () => {
    expect(isSourceFile("crates/engine/src/lib.rs")).toBe(true);
    expect(isSourceFile("packages/x/src/foo.js")).toBe(true);
  });
  it("does not match top-level files outside src/", () => {
    expect(isSourceFile("README.md")).toBe(false);
    expect(isSourceFile("Cargo.toml")).toBe(false);
    expect(isSourceFile("package.json")).toBe(false);
    expect(isSourceFile("CHANGELOG.md")).toBe(false);
    expect(isSourceFile(".github/workflows/ci.yml")).toBe(false);
    expect(isSourceFile("tests/foo.test.ts")).toBe(false);
  });
  it("does not match 'srcfoo/' (false-prefix)", () => {
    expect(isSourceFile("srcfoo/bar.ts")).toBe(false);
  });
});

describe("isManifestFile", () => {
  it("matches root-level manifests", () => {
    expect(isManifestFile("Cargo.toml")).toBe(true);
    expect(isManifestFile("package.json")).toBe(true);
  });
  it("matches nested manifests (workspace members)", () => {
    expect(isManifestFile("crates/engine/Cargo.toml")).toBe(true);
    expect(isManifestFile("packages/x/package.json")).toBe(true);
  });
  it("does not match other tomls / jsons", () => {
    expect(isManifestFile("tsconfig.json")).toBe(false);
    expect(isManifestFile("rustfmt.toml")).toBe(false);
    expect(isManifestFile("clippy.toml")).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Allow paths — gate should NOT block
// ---------------------------------------------------------------------

describe("evaluateVersioningGate — allow paths", () => {
  it("allows when nothing is staged", async () => {
    await seedInitial();
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(false);
    expect(r.stderr).toBe("");
  });

  it("allows docs-only commit (no src/ staged)", async () => {
    await seedInitial();
    await writeFile("README.md", "# updated\n");
    await writeFile("CHANGELOG.md", "## changes\n");
    stage("README.md");
    stage("CHANGELOG.md");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(false);
  });

  it("allows CI-only commit", async () => {
    await seedInitial();
    await writeFile(".github/workflows/ci.yml", "name: CI\n");
    stage(".github/workflows/ci.yml");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(false);
  });

  it("allows src + Cargo.toml version bump in same commit", async () => {
    await seedInitial();
    await writeFile("Cargo.toml", 'version = "0.1.0"\n');
    await writeFile("src/lib.rs", "// initial\n");
    stage("Cargo.toml");
    stage("src/lib.rs");
    commit("initial src + manifest");
    // Now bump:
    await writeFile("Cargo.toml", 'version = "0.1.1"\n');
    await writeFile("src/lib.rs", "// patched\n");
    stage("Cargo.toml");
    stage("src/lib.rs");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(false);
  });

  // Audit HIGH fix (v0.6.3): minified package.json was originally a
  // false-positive block because the regex anchored `^"version"` and
  // minified JSON has `"version"` mid-line. Drop the anchor.
  it("allows src + MINIFIED package.json version bump (audit HIGH regression)", async () => {
    await seedInitial();
    await writeFile("package.json", '{"name":"x","version":"0.1.0"}\n');
    await writeFile("src/index.ts", "// initial\n");
    stage("package.json");
    stage("src/index.ts");
    commit("initial");
    await writeFile("package.json", '{"name":"x","version":"0.1.1"}\n');
    await writeFile("src/index.ts", "// patched\n");
    stage("package.json");
    stage("src/index.ts");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(false);
  });

  it("allows src + package.json version bump in same commit (realistic multi-line JSON)", async () => {
    await seedInitial();
    // Real package.json is pretty-printed multi-line so the diff
    // surfaces a `"version": "..."` change on its own line.
    const pkgV1 = JSON.stringify({ name: "x", version: "0.1.0" }, null, 2) + "\n";
    const pkgV2 = JSON.stringify({ name: "x", version: "0.1.1" }, null, 2) + "\n";
    await writeFile("package.json", pkgV1);
    await writeFile("src/index.ts", "// initial\n");
    stage("package.json");
    stage("src/index.ts");
    commit("initial");
    await writeFile("package.json", pkgV2);
    await writeFile("src/index.ts", "// patched\n");
    stage("package.json");
    stage("src/index.ts");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Block paths — gate SHOULD block
// ---------------------------------------------------------------------

describe("evaluateVersioningGate — block paths", () => {
  it("blocks src/ change with no manifest staged", async () => {
    await seedInitial();
    await writeFile("Cargo.toml", 'version = "0.1.0"\n');
    await writeFile("src/lib.rs", "// initial\n");
    stage("Cargo.toml");
    stage("src/lib.rs");
    commit("initial src + manifest");
    // Now ONLY src changes, no manifest bump:
    await writeFile("src/lib.rs", "// edited\n");
    stage("src/lib.rs");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(true);
    expect(r.stderr).toContain("commit blocked");
    expect(r.stderr).toContain("src/lib.rs");
    expect(r.stderr).toContain("No Cargo.toml or package.json staged");
  });

  it("blocks src/ change with manifest staged but no version-line diff", async () => {
    await seedInitial();
    await writeFile("Cargo.toml", 'version = "0.1.0"\n[dependencies]\nfoo = "1"\n');
    await writeFile("src/lib.rs", "// initial\n");
    stage("Cargo.toml");
    stage("src/lib.rs");
    commit("initial");
    // Touch manifest (add dep) but DON'T bump version, also touch src:
    await writeFile("Cargo.toml", 'version = "0.1.0"\n[dependencies]\nfoo = "1"\nbar = "2"\n');
    await writeFile("src/lib.rs", "// edited\n");
    stage("Cargo.toml");
    stage("src/lib.rs");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(true);
    expect(r.stderr).toContain("no version-line diff");
    expect(r.stderr).toContain("Cargo.toml");
  });
});

// ---------------------------------------------------------------------
// Multi-manifest / workspace
// ---------------------------------------------------------------------

describe("evaluateVersioningGate — workspace / multi-manifest", () => {
  it("allows when ANY staged manifest has a version bump", async () => {
    await seedInitial();
    await writeFile("crates/a/Cargo.toml", 'version = "0.1.0"\n');
    await writeFile("crates/b/Cargo.toml", 'version = "0.1.0"\n');
    await writeFile("crates/a/src/lib.rs", "// a\n");
    await writeFile("crates/b/src/lib.rs", "// b\n");
    stage("crates/a/Cargo.toml");
    stage("crates/b/Cargo.toml");
    stage("crates/a/src/lib.rs");
    stage("crates/b/src/lib.rs");
    commit("initial");
    // Bump ONLY crate a; edit src in BOTH:
    await writeFile("crates/a/Cargo.toml", 'version = "0.1.1"\n');
    await writeFile("crates/a/src/lib.rs", "// a patched\n");
    await writeFile("crates/b/src/lib.rs", "// b edited\n");
    stage("crates/a/Cargo.toml");
    stage("crates/a/src/lib.rs");
    stage("crates/b/src/lib.rs");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    // Liberal policy: ANY manifest bump is enough. Workspace-wide
    // discipline is a v0.6.4+ refinement if needed.
    expect(r.block).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Emergency override
// ---------------------------------------------------------------------

describe("evaluateVersioningGate — emergency override", () => {
  it("ALLOWS with bypass warning when OPENSQUID_SKIP_VERSION_GATE=1", async () => {
    process.env.OPENSQUID_SKIP_VERSION_GATE = "1";
    expect(checkOverrideEnv()).toBe(true);
    await seedInitial();
    await writeFile("Cargo.toml", 'version = "0.1.0"\n');
    await writeFile("src/lib.rs", "// initial\n");
    stage("Cargo.toml");
    stage("src/lib.rs");
    commit("initial");
    await writeFile("src/lib.rs", "// edited\n");
    stage("src/lib.rs");
    const r = await evaluateVersioningGate({ cwd: repoDir });
    expect(r.block).toBe(false);
    expect(r.stderr).toContain("BYPASSED");
  });

  it("respects the env var only when EXACTLY '1'", async () => {
    process.env.OPENSQUID_SKIP_VERSION_GATE = "true";
    expect(checkOverrideEnv()).toBe(false);
    process.env.OPENSQUID_SKIP_VERSION_GATE = "1";
    expect(checkOverrideEnv()).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Fail-open invariant
// ---------------------------------------------------------------------

describe("evaluateVersioningGate — fail-open invariant", () => {
  it("ALLOWS with stderr warning when git is not available (non-repo cwd)", async () => {
    const notARepo = path.join(os.tmpdir(), `not-a-repo-${crypto.randomUUID()}`);
    await fs.mkdir(notARepo, { recursive: true });
    try {
      const r = await evaluateVersioningGate({ cwd: notARepo });
      expect(r.block).toBe(false);
      expect(r.stderr).toContain("git diff failed");
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true });
    }
  });
});

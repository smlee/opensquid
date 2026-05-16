/**
 * Versioning gate — pre-commit check enforcing per-commit patch bumps
 * (v0.6.3). Wired into the PreToolUse hook for `git commit` commands.
 *
 * Problem this fixes: I keep batching multiple fixes into one commit
 * and bumping the minor (or no bump at all) instead of one patch per
 * fix. The discipline rule was memorized (`mem-d2cc0e78`) but rules
 * I can ignore aren't structural protection. This gate makes the
 * discipline mechanical — if your commit touches source code AND
 * doesn't include a manifest version bump in the same commit, it
 * gets rejected before `git commit` runs.
 *
 * Detection:
 *   1. `git diff --cached --name-only` → list of staged files
 *   2. If no `src/**` files staged → allow (docs/CI/config commits
 *      don't need version bumps)
 *   3. If `src/**` files staged → require a manifest (Cargo.toml or
 *      package.json) to also be staged with a `version` line diff
 *   4. Otherwise → block with actionable message
 *
 * Fail-open invariant: any error running git or parsing output →
 * allow with a stderr warning (per the honesty-ledger + workflow-gate
 * precedent — never block on opensquid's own bug).
 *
 * Emergency override: `OPENSQUID_SKIP_VERSION_GATE=1` bypasses with a
 * loud stderr warning. For genuine emergencies (revert commits,
 * generated-code-only diffs, etc.) where the discipline doesn't
 * apply.
 */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

export interface VersioningGateInput {
  /** Working directory (the repo root). Defaults to process.cwd(). */
  cwd?: string;
}

export interface VersioningGateResult {
  /** True when the commit should be blocked. */
  block: boolean;
  /** Stderr message — always present when stderr should be written.
   * Non-blocking warnings also use this. */
  stderr: string;
}

export async function evaluateVersioningGate(
  input: VersioningGateInput = {},
): Promise<VersioningGateResult> {
  if (checkOverrideEnv()) {
    return {
      block: false,
      stderr: "🦑 [opensquid versioning-gate] BYPASSED via OPENSQUID_SKIP_VERSION_GATE=1\n",
    };
  }

  const cwd = input.cwd ?? process.cwd();

  // List staged files. `--no-renames` keeps the output simple (renames
  // appear as both old + new path rather than `R100\told\tnew`).
  let stagedFiles: string[];
  try {
    const { stdout } = await exec("git diff --cached --name-only --no-renames", {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    stagedFiles = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err) {
    return {
      block: false,
      stderr: `[opensquid versioning-gate] git diff failed (proceeding): ${err instanceof Error ? err.message : err}\n`,
    };
  }

  if (stagedFiles.length === 0) {
    // Nothing staged — git commit will fail on its own with no need
    // for this gate to intervene.
    return { block: false, stderr: "" };
  }

  const sourceFiles = stagedFiles.filter(isSourceFile);
  if (sourceFiles.length === 0) {
    // Docs / CI / config / fixtures / etc. — no source change, no bump needed.
    return { block: false, stderr: "" };
  }

  const manifests = stagedFiles.filter(isManifestFile);
  if (manifests.length === 0) {
    return {
      block: true,
      stderr: buildBlockMessage(sourceFiles, []),
    };
  }

  // At least one manifest is staged — check that at least one has a
  // version-line diff (just touching the manifest without bumping
  // version doesn't count).
  for (const m of manifests) {
    if (await manifestHasVersionBump(cwd, m)) {
      return { block: false, stderr: "" };
    }
  }

  return {
    block: true,
    stderr: buildBlockMessage(sourceFiles, manifests),
  };
}

/**
 * Is this a source file that should trigger version-bump enforcement?
 * Generous definition: anything under `src/` for any language we support.
 */
export function isSourceFile(p: string): boolean {
  // src/ at any depth (top-level or nested workspace member)
  return /(^|\/)src\//.test(p);
}

/** Is this the repo's version manifest? */
export function isManifestFile(p: string): boolean {
  const base = p.split("/").pop() ?? "";
  return base === "Cargo.toml" || base === "package.json";
}

/**
 * Look at the staged diff of a manifest and return true iff the diff
 * touches a `version = "..."` (Cargo.toml) or `"version": "..."`
 * (package.json) line.
 */
async function manifestHasVersionBump(cwd: string, manifestPath: string): Promise<boolean> {
  let diff: string;
  try {
    const { stdout } = await exec(
      `git diff --cached --no-color -U0 -- ${quoteShell(manifestPath)}`,
      { cwd, maxBuffer: 1024 * 1024 },
    );
    diff = stdout;
  } catch {
    return false;
  }
  // Look for added lines (start with `+` but not `+++`) that contain
  // a version assignment. Cargo: `version = "..."`. package.json:
  // `"version": "..."`. Match both shapes loosely.
  //
  // Anchor discipline:
  //   - Cargo (TOML, line-oriented) → anchor `^version` so we don't
  //     match a dep with `version = "..."` in `[dependencies.foo]`.
  //   - package.json (JSON, can be MINIFIED single-line) → do NOT
  //     anchor; `"version"` can appear mid-line in minified JSON.
  //     Audit fix v0.6.3: original `^"version"` regex false-blocked
  //     legitimate bumps in minified package.json.
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const body = line.slice(1).trim();
    if (/^version\s*=\s*"[^"]+"/.test(body)) return true; // Cargo.toml
    if (/"version"\s*:\s*"[^"]+"/.test(body)) return true; // package.json (line-anchorless)
  }
  return false;
}

function quoteShell(s: string): string {
  // Defensive single-quote shell escape. Manifest paths are usually
  // boring but we don't trust them blindly.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildBlockMessage(sourceFiles: string[], manifests: string[]): string {
  const srcSample = sourceFiles.slice(0, 5).join(", ") + (sourceFiles.length > 5 ? ", ..." : "");
  const lines = [
    `🦑 [opensquid versioning-gate] commit blocked — source changes without a version bump`,
    `  source files staged (${sourceFiles.length}): ${srcSample}`,
  ];
  if (manifests.length === 0) {
    lines.push(
      `  No Cargo.toml or package.json staged.`,
      `  Bump the patch version (per mem-d2cc0e78 — fix per commit, not batched), \`git add\` the manifest, then re-commit.`,
    );
  } else {
    lines.push(
      `  Manifest(s) staged but no version-line diff: ${manifests.join(", ")}`,
      `  Bump the version field (Cargo.toml: \`version = "x.y.z"\`, package.json: \`"version": "x.y.z"\`), re-stage, then re-commit.`,
    );
  }
  lines.push(`  Override (genuine emergency): set OPENSQUID_SKIP_VERSION_GATE=1 for this command.`);
  return lines.join("\n") + "\n";
}

/**
 * Emergency-override env var. Loud stderr warning on bypass so it
 * always shows up in scrollback / CI logs. Exported for the test
 * suite.
 */
export function checkOverrideEnv(): boolean {
  return process.env.OPENSQUID_SKIP_VERSION_GATE === "1";
}

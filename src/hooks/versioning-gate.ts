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
  let bumpedManifest: { path: string; jump: VersionJump | null } | null = null;
  for (const m of manifests) {
    const jump = await readManifestVersionBump(cwd, m);
    if (jump) {
      bumpedManifest = { path: m, jump };
      break;
    }
  }

  if (!bumpedManifest) {
    return {
      block: true,
      stderr: buildBlockMessage(sourceFiles, manifests),
    };
  }

  // 0.7.23 / D5 — catch-up bump detection. The PATCH-ONLY rule
  // ([[feedback_pre1_versioning]] v4) says every src commit = exactly
  // one patch bump. A jump like 0.7.10 → 0.7.14 in a single commit
  // means previous src commits skipped their bumps. Don't BLOCK
  // (legitimate explicit catch-ups exist), but surface a loud warning
  // so the skip is visible.
  const { jump } = bumpedManifest;
  if (jump && isMultiPatchJump(jump)) {
    return {
      block: false,
      stderr:
        `🦑 [opensquid versioning-gate] WARN: catch-up bump detected (${jump.from} → ${jump.to})\n` +
        `  PATCH-ONLY rule says one patch per commit. A multi-patch jump in one\n` +
        `  commit usually means earlier src commits shipped without bumps. Drift D5.\n`,
    };
  }

  return { block: false, stderr: "" };
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
 * Parsed version jump from a manifest's staged diff.
 *
 * 0.7.23 / D5 — added so the gate can surface multi-patch catch-up
 * jumps (e.g. 0.7.10 → 0.7.14) which indicate previous src commits
 * shipped without bumps.
 */
export interface VersionJump {
  from: string;
  to: string;
}

/**
 * Look at the staged diff of a manifest and return the version jump
 * (from → to). Returns null when the diff doesn't touch a `version`
 * line at all.
 *
 * Exported for direct testing.
 */
export async function readManifestVersionBump(
  cwd: string,
  manifestPath: string,
): Promise<VersionJump | null> {
  let diff: string;
  try {
    const { stdout } = await exec(
      `git diff --cached --no-color -U0 -- ${quoteShell(manifestPath)}`,
      { cwd, maxBuffer: 1024 * 1024 },
    );
    diff = stdout;
  } catch {
    return null;
  }
  return parseVersionJumpFromDiff(diff);
}

/**
 * Parse `+`/`-` lines from a manifest diff and extract the version
 * jump. Cargo: `version = "..."`. package.json: `"version": "..."`.
 *
 * Anchor discipline:
 *   - Cargo (TOML, line-oriented) → anchor `^version` so we don't
 *     match a dep with `version = "..."` in `[dependencies.foo]`.
 *   - package.json (JSON, can be MINIFIED single-line) → do NOT
 *     anchor; `"version"` can appear mid-line in minified JSON.
 *
 * Exported for direct testing.
 */
export function parseVersionJumpFromDiff(diff: string): VersionJump | null {
  let oldVersion: string | null = null;
  let newVersion: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const sign = line[0];
    if (sign !== "+" && sign !== "-") continue;
    const body = line.slice(1).trim();
    let v: string | null = null;
    const cargoMatch = body.match(/^version\s*=\s*"([^"]+)"/);
    if (cargoMatch) v = cargoMatch[1];
    if (v === null) {
      const npmMatch = body.match(/"version"\s*:\s*"([^"]+)"/);
      if (npmMatch) v = npmMatch[1];
    }
    if (v === null) continue;
    if (sign === "+") newVersion = v;
    else oldVersion = v;
  }
  if (!newVersion) return null;
  // New-version only (e.g. brand-new manifest with no prior `version`
  // line) is still a valid "version bump" — treat oldVersion as empty.
  return { from: oldVersion ?? "", to: newVersion };
}

/**
 * Detect a multi-patch jump: same major.minor, but patch advances by
 * more than 1 (catch-up bump).
 *
 * Returns false for:
 *   - First-time bumps (from === "")
 *   - Same-patch (no actual jump, shouldn't happen with proper diff)
 *   - Minor/major bumps (those are user-authorized; PATCH-ONLY rule
 *     forbids the agent from naming them but doesn't make them "drift")
 *   - Non-SemVer version strings (best-effort parse)
 *
 * Exported for direct testing.
 */
export function isMultiPatchJump(jump: VersionJump): boolean {
  const oldParts = parseSemver(jump.from);
  const newParts = parseSemver(jump.to);
  if (!oldParts || !newParts) return false;
  // Only flag same-major.minor with patch jump > 1.
  if (oldParts.major !== newParts.major) return false;
  if (oldParts.minor !== newParts.minor) return false;
  return newParts.patch > oldParts.patch + 1;
}

function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
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

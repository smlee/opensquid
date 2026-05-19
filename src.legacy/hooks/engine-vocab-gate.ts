/**
 * Engine vocabulary gate — pre-commit check enforcing substrate purity
 * in engine repos (0.7.21 / drift D6).
 *
 * Wired into the PreToolUse hook for `git commit` commands when the
 * cwd is detected as an engine repo. Catches commit messages AND
 * staged content (CHANGELOG.md, code comments, etc.) that reference
 * consumer-product names like `opensquid` or `claude code` — engine
 * is general substrate and must not name specific consumers per
 * `[[feedback_engine_vocabulary_discipline]]`.
 *
 * Why this gate exists: the existing `substrate-purity` pattern in
 * drift-patterns.ts only matched commit messages where the bash
 * command itself contained the path `loop/engine`. Real engine work
 * happens in cwd /Users/slee/projects/loop/engine/ with the command
 * just `git commit -m "..."` — the path isn't in the command. This
 * gate uses cwd directly + scans both the -m message AND the staged
 * diff content.
 *
 * Detection:
 *   1. Skip silently if cwd doesn't look like an engine repo.
 *   2. Parse the -m message text from the bash command; check for
 *      consumer names.
 *   3. Run `git diff --cached` and scan added lines for consumer
 *      names, excluding `src/host/claude_code/**` paths and lines
 *      that look like MIT attribution comments.
 *   4. Block with an actionable message if any leak found.
 *
 * Fail-open invariant: any error parsing the command, running git, or
 * scanning the diff → allow with stderr warning. Mirrors the
 * workflow-gate / versioning-gate precedent.
 *
 * Override: `OPENSQUID_SKIP_ENGINE_VOCAB_GATE=1` bypasses with loud
 * stderr warning. For genuine emergencies where naming the consumer
 * is unavoidable (e.g. a migration-note commit explicitly tracking
 * cross-product impact).
 */

import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCb);

/**
 * Consumer product names that may not appear in engine artifacts.
 * Case-insensitive. Word-boundary-ish so substrings like
 * "openssquidly" don't false-fire — but tight enough to catch
 * "opensquid's", "claude_code", "open squid", etc.
 */
const CONSUMER_NAME_REGEX = /\b(opensquid|claude[._\- ]code|open[._\- ]squid)\b/i;

/**
 * File path prefix that's allowed to name consumer products structurally
 * (engine's per-host adapter directories). Adding more here as new host
 * adapters land is fine.
 */
const STRUCTURALLY_ALLOWED_PATH_PREFIXES = ["src/host/claude_code/"] as const;

/**
 * Lines starting with comment syntax that mention MIT attribution are
 * allowed — they're licence headers for cherry-picked code.
 */
const MIT_ATTRIBUTION_REGEX = /(\/\/|#|\*).*\b(MIT|Copyright|License)\b/i;

export interface EngineVocabGateInput {
  /** Working directory — used to detect if this is an engine repo and
   * as the cwd for the git diff subprocess. */
  cwd?: string;
  /** The full bash command text — scanned for `-m "..."` message content. */
  bashCommand?: string;
}

export interface EngineVocabGateResult {
  block: boolean;
  stderr: string;
}

/**
 * Evaluate the gate against a planned `git commit` invocation.
 *
 * Exported for direct unit testing.
 */
export async function evaluateEngineVocabGate(
  input: EngineVocabGateInput,
): Promise<EngineVocabGateResult> {
  if (checkOverrideEnv()) {
    return {
      block: false,
      stderr: "🦑 [opensquid engine-vocab-gate] BYPASSED via OPENSQUID_SKIP_ENGINE_VOCAB_GATE=1\n",
    };
  }

  const cwd = input.cwd;
  if (!cwd || !isEngineRepoCwd(cwd)) {
    // Not an engine repo — gate doesn't apply. Silent allow.
    return { block: false, stderr: "" };
  }

  const violations: string[] = [];

  // Scan 1: the -m message text from the bash command.
  if (input.bashCommand) {
    const messageHit = scanCommitMessage(input.bashCommand);
    if (messageHit) {
      violations.push(`  - commit message references "${messageHit}"`);
    }
  }

  // Scan 2: staged file content (CHANGELOG.md edits, code comments, etc.).
  try {
    const stagedHits = await scanStagedDiff(cwd);
    for (const hit of stagedHits) {
      violations.push(`  - ${hit.file}: "${hit.match}" on added line`);
    }
  } catch (err) {
    return {
      block: false,
      stderr: `[opensquid engine-vocab-gate] git diff failed (proceeding): ${err instanceof Error ? err.message : err}\n`,
    };
  }

  if (violations.length === 0) {
    return { block: false, stderr: "" };
  }

  return {
    block: true,
    stderr: buildBlockMessage(violations),
  };
}

/**
 * Heuristic: is this cwd an engine repo?
 *
 * Catches:
 *   - /any/path/engine (engine repo as a directory inside a monorepo)
 *   - /any/path/loop-engine (standalone engine repo)
 *   - /any/path/<anything>-engine
 *
 * False-positives risk: a `/Users/foo/projects/build-engine/` Vue.js
 * project would match. Acceptable — this gate runs only on `git commit`
 * in that dir, and the regex would not match any of its content. Net
 * cost: one git-diff subprocess call. Cheap.
 *
 * Exported for direct unit testing.
 */
export function isEngineRepoCwd(cwd: string): boolean {
  // Normalize trailing slash.
  const normalized = cwd.replace(/\/+$/, "");
  // Match: ends with `/engine` OR ends with `*-engine`
  return /\/engine$|-engine$/.test(normalized);
}

/**
 * Parse a `git commit -m "..."` (or `-m '...'`) message from a bash
 * command and check for consumer names. Returns the first matched
 * consumer-name substring, or null if clean.
 *
 * Handles common shells: -m followed by a quoted string, OR -m
 * followed by a HEREDOC (`-m "$(cat <<'EOF' ... EOF)"`). For HEREDOC
 * the regex below catches the body since it's embedded in the bash
 * command string.
 *
 * Exported for direct unit testing.
 */
export function scanCommitMessage(bashCommand: string): string | null {
  // Look for -m followed by a quoted string. Match both `-m "..."` and
  // `-m '...'` forms, including HEREDOC bodies that get interpolated.
  // Simple approach: scan the ENTIRE command for consumer names that
  // appear after a `-m`. False-positives if the command has unrelated
  // `-m` content followed by consumer names — acceptable for D6.
  const dashMIndex = bashCommand.search(/\s-m\b/);
  if (dashMIndex === -1) return null;
  const afterDashM = bashCommand.slice(dashMIndex);
  const match = afterDashM.match(CONSUMER_NAME_REGEX);
  return match ? match[0] : null;
}

interface DiffHit {
  file: string;
  match: string;
}

/**
 * Run `git diff --cached` and scan added lines for consumer names.
 * Excludes structurally-allowed paths and MIT attribution comments.
 *
 * Returns the list of hits (empty if clean).
 *
 * Exported for direct unit testing.
 */
export async function scanStagedDiff(cwd: string): Promise<DiffHit[]> {
  const { stdout } = await exec("git diff --cached --unified=0 --no-color", {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseDiffForConsumerNames(stdout);
}

/**
 * Parse a unified diff text and return consumer-name hits on added
 * lines, with path-prefix and attribution-comment exclusions applied.
 *
 * Exported for direct unit testing (avoids needing a git subprocess
 * in unit tests).
 */
export function parseDiffForConsumerNames(diff: string): DiffHit[] {
  const hits: DiffHit[] = [];
  let currentFile: string | null = null;

  for (const line of diff.split("\n")) {
    // Track file context. Unified diff: `+++ b/path/to/file`
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "").trim();
      currentFile = path === "/dev/null" ? null : path;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) continue;

    // Only scan added lines.
    if (!line.startsWith("+")) continue;
    // Skip the `+++` header (caught above) and pure `+` lines.
    if (line.length === 1) continue;
    const content = line.slice(1);

    if (currentFile === null) continue;
    if (isStructurallyAllowedPath(currentFile)) continue;
    if (MIT_ATTRIBUTION_REGEX.test(content)) continue;

    const match = content.match(CONSUMER_NAME_REGEX);
    if (match) {
      hits.push({ file: currentFile, match: match[0] });
    }
  }
  return hits;
}

function isStructurallyAllowedPath(path: string): boolean {
  return STRUCTURALLY_ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function buildBlockMessage(violations: string[]): string {
  return (
    `🦑 [opensquid engine-vocab-gate] engine commit blocked — consumer-product names detected\n` +
    `${violations.join("\n")}\n` +
    `\n` +
    `Engine is general substrate per [[feedback_engine_vocabulary_discipline]].\n` +
    `Re-word using engine-domain terminology (e.g. "the RPC writer" / "the consumer",\n` +
    `not "opensquid"; "claude_session_id" → neutral identifier). For per-host adapter\n` +
    `code that is structurally consumer-specific, place under src/host/claude_code/**.\n` +
    `\n` +
    `Override (genuine emergency): set OPENSQUID_SKIP_ENGINE_VOCAB_GATE=1 for this command.\n`
  );
}

/** Exported for the test suite. */
export function checkOverrideEnv(): boolean {
  return process.env.OPENSQUID_SKIP_ENGINE_VOCAB_GATE === "1";
}

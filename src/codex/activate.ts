/**
 * Codex activation evaluation — decide whether a codex's `detected_by`
 * matches the current project context (typically `process.cwd()`).
 *
 * Used by the recall handler to filter out lessons from codexes that
 * don't apply to the active project. Without this, recall would
 * surface React-specific lessons inside a Rust project (cross-codex
 * contamination).
 *
 * Coverage:
 *   - file_exists / dir_exists / file_match / file_glob → filesystem-evaluated
 *   - user_pinned → always true (codex was explicitly installed)
 *   - all_of / any_of → recursive combinators
 *   - memory_match / conversation_signal → default true (need runtime
 *     context the recall handler doesn't carry; orchestrator (O3) is
 *     the proper place for these)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getCodex } from "./store.js";
import type { Codex, CodexDetection, FocusedCodex } from "./types.js";
import { isCompositeCodex, isFocusedCodex } from "./types.js";

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Evaluate a codex's activation against a project context.
 *
 * - Composite codexes are not directly activatable; treat as inactive
 *   here (their `includes` activate independently via their own
 *   `detected_by`).
 * - Focused codex with no `detected_by`: defaults to active (the codex
 *   author wanted always-on).
 * - `activation_scope: user` + `user_pinned`: always active.
 * - Otherwise: evaluate the `detected_by` list (any-of semantics —
 *   matching ANY listed signal activates).
 */
export async function isCodexActive(codex: Codex, cwd: string): Promise<boolean> {
  if (isCompositeCodex(codex)) return false;
  if (!isFocusedCodex(codex)) return false;
  return isFocusedCodexActive(codex, cwd);
}

async function isFocusedCodexActive(codex: FocusedCodex, cwd: string): Promise<boolean> {
  // No detection signals declared → activate (author wanted always-on).
  if (!codex.detected_by || codex.detected_by.length === 0) return true;
  // Top-level list = OR — any matching signal activates.
  for (const detection of codex.detected_by) {
    if (await evaluateDetection(detection, cwd)) return true;
  }
  return false;
}

/**
 * Evaluate a single detection signal against a project context.
 *
 * Returns false on unknown kinds (forward-compat — future engine
 * versions could add detection kinds opensquid doesn't recognize yet;
 * fail closed rather than over-activate).
 */
export async function evaluateDetection(detection: CodexDetection, cwd: string): Promise<boolean> {
  switch (detection.kind) {
    case "user_pinned":
      return true;
    case "file_exists":
      return fileExistsAt(path.resolve(cwd, detection.path));
    case "dir_exists":
      return dirExistsAt(path.resolve(cwd, detection.path));
    case "file_match":
      return fileMatches(path.resolve(cwd, detection.path), detection.matches);
    case "file_glob":
      return globAtLeast(cwd, detection.pattern, detection.min_count ?? 1);
    case "all_of": {
      for (const c of detection.conditions) {
        if (!(await evaluateDetection(c, cwd))) return false;
      }
      return true;
    }
    case "any_of": {
      for (const c of detection.conditions) {
        if (await evaluateDetection(c, cwd)) return true;
      }
      return false;
    }
    case "memory_match":
    case "conversation_signal":
      // These need runtime context the recall handler doesn't carry.
      // Defaulting to true is the conservative choice: don't filter
      // lessons out solely because we can't evaluate these signals here.
      // Orchestrator (O3) will evaluate them properly.
      return true;
    default: {
      // Forward-compat: unknown kinds → fail closed.
      // Exhaustiveness check at compile time via the `never` cast.
      const _exhaustive: never = detection;
      void _exhaustive;
      return false;
    }
  }
}

// ---------------------------------------------------------------------
// Activation cache (per-cwd, per-recall-handler-session)
// ---------------------------------------------------------------------

/**
 * Caches codex activation decisions for one project context.
 *
 * Reuse across multiple recall calls in the same session — avoids
 * re-reading codex.yaml files on every recall. Per-cwd because the
 * answer depends on the project being worked in.
 */
export class CodexActivationCache {
  private decisions = new Map<string, Promise<boolean>>();

  constructor(
    private readonly cwd: string,
    private readonly rootDir?: string,
  ) {}

  /** Returns true iff the codex's `detected_by` matches this cwd. */
  async isActive(codexId: string): Promise<boolean> {
    let pending = this.decisions.get(codexId);
    if (!pending) {
      pending = this.evaluate(codexId);
      this.decisions.set(codexId, pending);
    }
    return pending;
  }

  private async evaluate(codexId: string): Promise<boolean> {
    try {
      const codex = await getCodex(codexId, { rootDir: this.rootDir });
      return isCodexActive(codex, this.cwd);
    } catch {
      // Missing or malformed codex → treat as inactive. Lessons from
      // an uninstalled codex shouldn't surface even if they're still
      // in the lesson store (stale state).
      return false;
    }
  }
}

// ---------------------------------------------------------------------
// Lesson → codex id extraction
// ---------------------------------------------------------------------

/**
 * Extract the codex id from a lesson description.
 *
 * opensquid's codex CLI seeds lessons with descriptions like:
 *   "before any git push or release (codex:loop-engineering-workflow)"
 *
 * Returns null for lessons not seeded from a codex (the pre-codex
 * lessons created by `lesson.create` without `pack_id`).
 */
export function extractCodexId(description: string): string | null {
  const m = description.match(/\(codex:([a-z0-9][a-z0-9._-]{0,127})\)\s*$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------
// Filesystem primitives
// ---------------------------------------------------------------------

async function fileExistsAt(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExistsAt(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileMatches(filePath: string, matches: Record<string, unknown>): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return false;
  }
  // Try JSON first (the most common manifest format). Fall back to
  // tolerant key-presence check for non-JSON files.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Non-JSON: do a substring check on the dotted-path key. Coarse
    // but correct for the "contains" use case.
    for (const key of Object.keys(matches)) {
      if (!content.includes(key)) return false;
    }
    return true;
  }
  for (const [keyPath, _expected] of Object.entries(matches)) {
    const value = walkPath(parsed, keyPath);
    // MVP semantics: a key being PRESENT (truthy + non-null) at the
    // path means "match." Full semver-range matching is future work;
    // for activation gating, key-presence is sufficient — a project
    // with `dependencies.react` defined IS a React project.
    if (value === undefined || value === null || value === "") return false;
  }
  return true;
}

function walkPath(obj: unknown, dottedPath: string): unknown {
  const parts = dottedPath.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

async function globAtLeast(cwd: string, pattern: string, minCount: number): Promise<boolean> {
  // Lightweight glob — supports `**/*.ext` and `dir/**/*.{a,b}` patterns.
  // Avoids pulling in a full glob dependency for one detection kind.
  const matches = await collectGlobMatches(cwd, pattern);
  return matches.length >= minCount;
}

async function collectGlobMatches(cwd: string, pattern: string): Promise<string[]> {
  // Split into a fixed-prefix and the matchable tail. Walk only what
  // the tail says.
  const segments = pattern.split("/");
  let prefix = cwd;
  let firstWildcard = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].includes("*")) {
      firstWildcard = i;
      break;
    }
    prefix = path.join(prefix, segments[i]);
  }
  if (firstWildcard === -1) {
    // No wildcards — the pattern is literal; check existence directly.
    try {
      await fs.access(prefix);
      return [prefix];
    } catch {
      return [];
    }
  }
  const tail = segments.slice(firstWildcard).join("/");
  const fileRegex = globTailToRegex(tail);
  const results: string[] = [];
  await walkDir(prefix, "", fileRegex, results);
  return results;
}

async function walkDir(
  rootAbs: string,
  relPath: string,
  fileRegex: RegExp,
  out: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(rootAbs, relPath), {
      withFileTypes: true,
    });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await walkDir(rootAbs, childRel, fileRegex, out);
    } else if (entry.isFile() && fileRegex.test(childRel)) {
      out.push(path.join(rootAbs, childRel));
    }
  }
}

function globTailToRegex(tail: string): RegExp {
  // Translate a glob tail (supports `**`, `*`, `{a,b}`) into a regex.
  let re = "";
  let i = 0;
  while (i < tail.length) {
    const c = tail[i];
    if (c === "*" && tail[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (tail[i] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "{") {
      const end = tail.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i++;
        continue;
      }
      const opts = tail.slice(i + 1, end).split(",");
      re += `(?:${opts.map(escapeRegexLiteral).join("|")})`;
      i = end + 1;
    } else if (".+^$()|\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.+*?^$()|[\]\\{}]/g, "\\$&");
}

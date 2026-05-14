/**
 * Project-scope auto-detection for memorize/recall defaults.
 *
 * v0.3.1 wedge-product fix: a global CLAUDE.md installer auto-calls
 * `recall` from every project. Without scope isolation that means
 * EVERY project surfaces EVERY memory you've ever stored — the cross-
 * project bleed that the engine's `MemoryScope::Project(id)` exists
 * to prevent. This module decides what the "current project" is so
 * opensquid can pass it to the engine implicitly.
 *
 * Priority order:
 *  1. `OPENSQUID_PROJECT` env var — explicit override, always wins.
 *  2. `git rev-parse --show-toplevel` basename — for CWDs inside a git
 *     repo. Most common dev case.
 *  3. `null` — caller falls back to `MemoryScope::User`.
 */
import { execSync } from "node:child_process";
import * as path from "node:path";

import type { MemoryScope } from "./engine-client.js";

export interface DetectedProject {
  project: string;
}

/**
 * Returns `{ project: <name> }` if a project scope can be detected,
 * else `null`. Never throws — git failures and missing env both fall
 * through to `null`.
 */
export function detectProjectScope(cwd: string = process.cwd()): DetectedProject | null {
  const explicit = process.env.OPENSQUID_PROJECT?.trim();
  if (explicit) return { project: explicit };

  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return { project: path.basename(root) };
  } catch {
    // Not a git repo, or git not installed — fall through.
  }
  return null;
}

/**
 * The default scope for `memorize` when the caller didn't supply one:
 * project-scoped if we detected one, else user-scoped.
 */
export function defaultMemorizeScope(cwd?: string): MemoryScope {
  const detected = detectProjectScope(cwd);
  return detected ? { project: detected.project } : "user";
}

/**
 * The default scope filter for `recall` when the caller didn't supply
 * one. We return user-scope + the detected project-scope (if any).
 * This matches "show me everything I'd reasonably want here" — your
 * own user memories plus this project's memories.
 *
 * Returns an `any_of` filter with one or two scopes; never returns
 * `null` (an unfiltered recall would surface other projects' memories).
 */
export function defaultRecallScopeFilter(cwd?: string): {
  kind: "any_of";
  scopes: MemoryScope[];
} {
  const detected = detectProjectScope(cwd);
  const scopes: MemoryScope[] = ["user"];
  if (detected) scopes.push({ project: detected.project });
  return { kind: "any_of", scopes };
}

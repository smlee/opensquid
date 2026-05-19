/**
 * Project-scope auto-detection for memorize/recall defaults.
 *
 * Priority order (v0.4+ with project ID card):
 *  1. `OPENSQUID_PROJECT` env var — explicit override, always wins.
 *  2. **Project ID card** at `.opensquid/project.json` (walking up from
 *     cwd) — stable across moves/renames. v0.4 addition.
 *  3. `git rev-parse --show-toplevel` basename — fallback for projects
 *     that don't have a card yet (auto-created on first memorize).
 *  4. `null` — caller falls back to `MemoryScope::User`.
 *
 * The sync helpers below keep the v0.3 wire surface; the async
 * variants consult the ID card and are preferred for new call sites.
 */
import { execSync } from "node:child_process";
import * as path from "node:path";

import type { MemoryScope } from "./engine-client.js";
import { applyResolution, findProjectCard, resolveProject } from "./project.js";

export interface DetectedProject {
  project: string;
}

/**
 * Sync detection (v0.3.1 surface). Does NOT consult the project ID
 * card. Use the async variant for v0.4+ behavior.
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
 * v0.4: async detection that consults the project ID card first.
 *
 * Order:
 *   1. OPENSQUID_PROJECT env → wins
 *   2. .opensquid/project.json card (any ancestor of cwd) → stable id
 *   3. git basename → fallback
 *   4. null
 */
export async function detectProjectScopeAsync(
  cwd: string = process.cwd(),
): Promise<DetectedProject | null> {
  const explicit = process.env.OPENSQUID_PROJECT?.trim();
  if (explicit) return { project: explicit };

  const card = await findProjectCard(cwd);
  if (card) return { project: card.card.id };

  return detectProjectScope(cwd);
}

/**
 * Sync default-memorize-scope (v0.3.1 surface).
 */
export function defaultMemorizeScope(cwd?: string): MemoryScope {
  const detected = detectProjectScope(cwd);
  return detected ? { project: detected.project } : "user";
}

/**
 * v0.4: async default-memorize-scope that consults the project ID
 * card. Also AUTO-CREATES the card on first call in a new project
 * (so the second call onward gets a stable id even if the user
 * renames the directory). Pass `autoCreate: false` to skip creation.
 */
export async function defaultMemorizeScopeAsync(
  cwd: string = process.cwd(),
  options: { autoCreate?: boolean } = {},
): Promise<MemoryScope> {
  const explicit = process.env.OPENSQUID_PROJECT?.trim();
  if (explicit) return { project: explicit };

  const card = await findProjectCard(cwd);
  if (card) return { project: card.card.id };

  // No card yet — auto-create if allowed, otherwise fall through to
  // sync detection (returns git basename or "user").
  if (options.autoCreate !== false) {
    const resolved = await resolveProject(cwd);
    if (resolved.kind === "new") {
      const created = await applyResolution(cwd, resolved, { autoCreate: true });
      if (created) return { project: created.id };
    }
  }
  return defaultMemorizeScope(cwd);
}

/**
 * Sync default-recall-scope-filter (v0.3.1 surface).
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

/**
 * v0.4: async default-recall-scope-filter that consults the project
 * ID card. Does NOT auto-create a card — recall is read-only.
 */
export async function defaultRecallScopeFilterAsync(
  cwd: string = process.cwd(),
): Promise<{ kind: "any_of"; scopes: MemoryScope[] }> {
  const detected = await detectProjectScopeAsync(cwd);
  const scopes: MemoryScope[] = ["user"];
  if (detected) scopes.push({ project: detected.project });
  return { kind: "any_of", scopes };
}

/**
 * Project identity — decouple project scope from filesystem path.
 *
 * Two artifacts work together:
 *
 *   1. **Local ID card** at `<project-root>/.opensquid/project.json` —
 *      stable identity that travels with the project across moves /
 *      renames. Contains `id` (human-friendly), `uuid` (machine-stable),
 *      `created_at`.
 *
 *   2. **Global registry** at `~/.opensquid/projects.json` — index of
 *      all known projects by uuid. Tracks `last_seen_path`,
 *      `last_seen_at`, `status` (active|deleted) so we can detect
 *      moves and prune deletes.
 *
 * State machine on `resolveProject(cwd)`:
 *
 *   - card present, registry agrees on path → **known**
 *   - card present, registry has different path for this uuid → **moved**
 *     (registry's old path may or may not still exist; we update both)
 *   - card absent → **new** (caller decides whether to auto-create)
 *
 * `pruneDeleted()` sweeps the registry: for each active entry whose
 * `last_seen_path` no longer exists on disk, flip status to "deleted".
 */

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveDataRoot } from "./codex/store.js";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface ProjectCard {
  /** Schema version; bump when the file shape changes. */
  version: 1;
  /** Human-friendly id (default: git basename of project root). */
  id: string;
  /** Machine-stable uuid that survives moves + id renames. */
  uuid: string;
  /** ISO timestamp the card was first written. */
  created_at: string;
}

export type ProjectStatus = "active" | "deleted";

export interface RegistryEntry {
  id: string;
  last_seen_path: string;
  last_seen_at: string;
  created_at: string;
  status: ProjectStatus;
}

export interface Registry {
  version: 1;
  /** Map of uuid → registry entry. */
  projects: Record<string, RegistryEntry>;
}

export type ResolvedProject =
  | { kind: "known"; card: ProjectCard; cardPath: string }
  | {
      kind: "moved";
      card: ProjectCard;
      cardPath: string;
      from_path: string;
    }
  | {
      kind: "new";
      project_root: string | null;
      suggested_id: string;
    };

// ---------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------

const CARD_DIR = ".opensquid";
const CARD_FILE = "project.json";
const REGISTRY_FILE = "projects.json";

/** Path to the registry file. */
export function registryPath(dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), REGISTRY_FILE);
}

/** Path the ID card WOULD live at for a given project root. */
export function cardPathForRoot(projectRoot: string): string {
  return path.join(projectRoot, CARD_DIR, CARD_FILE);
}

// ---------------------------------------------------------------------
// Card load / save
// ---------------------------------------------------------------------

/**
 * Walk up from `cwd` looking for a `.opensquid/project.json` card.
 * Stops at the filesystem root. Returns the card + the path the
 * card was found at, or null if no card exists in any ancestor.
 */
export async function findProjectCard(
  cwd: string,
): Promise<{ card: ProjectCard; cardPath: string } | null> {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, CARD_DIR, CARD_FILE);
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as ProjectCard;
      if (parsed && parsed.version === 1 && parsed.uuid && parsed.id) {
        return { card: parsed, cardPath: candidate };
      }
    } catch {
      // ignore — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Write a project card at `<projectRoot>/.opensquid/project.json`.
 * Refuses to overwrite an existing card unless `force` is set —
 * overwriting is a manual operation, not an accidental one.
 */
export async function writeProjectCard(
  projectRoot: string,
  card: ProjectCard,
  options: { force?: boolean } = {},
): Promise<{ cardPath: string }> {
  const cardPath = cardPathForRoot(projectRoot);
  try {
    await fs.access(cardPath);
    if (!options.force) {
      throw new Error(`project card already exists at ${cardPath} (use force to overwrite)`);
    }
  } catch (err) {
    // Re-throw real errors; ENOENT means we proceed.
    if (
      (err as NodeJS.ErrnoException).code !== "ENOENT" &&
      !(err instanceof Error && err.message.includes("already exists"))
    ) {
      throw err;
    }
    if (err instanceof Error && err.message.includes("already exists")) throw err;
  }
  await fs.mkdir(path.dirname(cardPath), { recursive: true });
  await fs.writeFile(cardPath, JSON.stringify(card, null, 2) + "\n", "utf8");
  return { cardPath };
}

// ---------------------------------------------------------------------
// Registry load / save
// ---------------------------------------------------------------------

export async function loadRegistry(dataRoot?: string): Promise<Registry> {
  const p = registryPath(dataRoot);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Registry;
    if (parsed && parsed.version === 1 && parsed.projects) return parsed;
  } catch {
    // missing or malformed — return a fresh registry
  }
  return { version: 1, projects: {} };
}

export async function saveRegistry(reg: Registry, dataRoot?: string): Promise<void> {
  const p = registryPath(dataRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------
// Resolve project state
// ---------------------------------------------------------------------

/**
 * Determine the project state for a given cwd.
 *
 * - Walks up from cwd for a card.
 * - Cross-references with the registry.
 * - Returns the state without mutating either file.
 *
 * `applyResolution` is the side-effect step: it updates the registry
 * based on the resolved state (and creates a card for `new` IF the
 * caller asks it to).
 */
export async function resolveProject(
  cwd: string,
  options: { dataRoot?: string } = {},
): Promise<ResolvedProject> {
  const found = await findProjectCard(cwd);
  if (!found) {
    const suggested = await suggestedIdForCwd(cwd);
    return { kind: "new", project_root: null, suggested_id: suggested };
  }
  const reg = await loadRegistry(options.dataRoot);
  const projectRoot = path.dirname(path.dirname(found.cardPath));
  const entry = reg.projects[found.card.uuid];
  if (!entry || entry.last_seen_path === projectRoot) {
    return { kind: "known", card: found.card, cardPath: found.cardPath };
  }
  return {
    kind: "moved",
    card: found.card,
    cardPath: found.cardPath,
    from_path: entry.last_seen_path,
  };
}

/**
 * Side-effecting companion to `resolveProject`. Updates the registry
 * (creating the card if asked for `new`). Idempotent.
 *
 * - `known`: bump `last_seen_at` only.
 * - `moved`: update `last_seen_path` + `last_seen_at`.
 * - `new`: if `autoCreate` is true, create a card at `cwd` + register
 *   it. Otherwise return null.
 */
export async function applyResolution(
  cwd: string,
  resolved: ResolvedProject,
  options: { dataRoot?: string; autoCreate?: boolean; id?: string } = {},
): Promise<ProjectCard | null> {
  const dataRoot = options.dataRoot;
  const now = new Date().toISOString();
  const reg = await loadRegistry(dataRoot);

  if (resolved.kind === "known") {
    const entry = reg.projects[resolved.card.uuid];
    if (entry) {
      entry.last_seen_at = now;
      entry.status = "active";
    } else {
      const projectRoot = path.dirname(path.dirname(resolved.cardPath));
      reg.projects[resolved.card.uuid] = {
        id: resolved.card.id,
        last_seen_path: projectRoot,
        last_seen_at: now,
        created_at: resolved.card.created_at,
        status: "active",
      };
    }
    await saveRegistry(reg, dataRoot);
    return resolved.card;
  }

  if (resolved.kind === "moved") {
    const projectRoot = path.dirname(path.dirname(resolved.cardPath));
    reg.projects[resolved.card.uuid] = {
      id: resolved.card.id,
      last_seen_path: projectRoot,
      last_seen_at: now,
      created_at: reg.projects[resolved.card.uuid]?.created_at ?? resolved.card.created_at,
      status: "active",
    };
    await saveRegistry(reg, dataRoot);
    return resolved.card;
  }

  // kind === "new"
  if (!options.autoCreate) return null;
  const id = options.id ?? resolved.suggested_id;
  const uuid = crypto.randomUUID();
  const created_at = now;
  const card: ProjectCard = { version: 1, id, uuid, created_at };
  await writeProjectCard(path.resolve(cwd), card);
  reg.projects[uuid] = {
    id,
    last_seen_path: path.resolve(cwd),
    last_seen_at: now,
    created_at,
    status: "active",
  };
  await saveRegistry(reg, dataRoot);
  return card;
}

// ---------------------------------------------------------------------
// Registry maintenance
// ---------------------------------------------------------------------

/**
 * Mark registry entries as "deleted" when their `last_seen_path` no
 * longer exists on disk. Does NOT actually remove the entry — kept
 * for historical reference and so the user can see what they had.
 *
 * Returns the count of entries that flipped from active → deleted.
 */
export async function pruneDeleted(dataRoot?: string): Promise<{
  swept: number;
  removed_ids: string[];
}> {
  const reg = await loadRegistry(dataRoot);
  let swept = 0;
  const removed_ids: string[] = [];
  for (const [uuid, entry] of Object.entries(reg.projects)) {
    if (entry.status !== "active") continue;
    try {
      await fs.access(entry.last_seen_path);
    } catch {
      entry.status = "deleted";
      swept++;
      removed_ids.push(entry.id);
      void uuid;
    }
  }
  if (swept > 0) await saveRegistry(reg, dataRoot);
  return { swept, removed_ids };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Default-id heuristic: git toplevel basename if available, else cwd
 * basename, else "project".
 */
async function suggestedIdForCwd(cwd: string): Promise<string> {
  const gitTop = await gitToplevel(cwd);
  if (gitTop) return path.basename(gitTop);
  const cwdName = path.basename(path.resolve(cwd));
  return cwdName || "project";
}

async function gitToplevel(cwd: string): Promise<string | null> {
  // Walk up looking for a `.git` directory.
  let dir = path.resolve(cwd);
  while (true) {
    try {
      const stat = await fs.stat(path.join(dir, ".git"));
      if (stat.isDirectory()) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // tilde-fallback only used for tests where HOME might point at /
      void os.homedir;
      return null;
    }
    dir = parent;
  }
}

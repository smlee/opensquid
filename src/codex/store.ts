/**
 * Codex local storage — filesystem layer for installed codexes.
 *
 * Stores codex YAML + lesson markdown files at <root>/codexes/<id>/.
 * Engine sees none of this; it only stores the resulting lessons that
 * opensquid seeds via `lesson.create` with `authored_by: Pack(<id>)`.
 *
 * Resolution order for the data root:
 *   1. `rootDir` parameter (explicit override; used by tests)
 *   2. `OPENSQUID_HOME` env var
 *   3. `LOOP_HOME` env var (engine-shared)
 *   4. `~/.opensquid/` default
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Codex } from "./types.js";
import { parseCodexYaml } from "./parse.js";
import { stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export type CodexStoreErrorCode =
  | "NOT_FOUND"
  | "ALREADY_INSTALLED"
  | "INVALID_ID"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "PARSE_FAILED";

export class CodexStoreError extends Error {
  constructor(
    public readonly code: CodexStoreErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CodexStoreError";
  }
}

// ---------------------------------------------------------------------
// Data root resolution
// ---------------------------------------------------------------------

/**
 * Resolve the opensquid data root.
 *
 * Order: explicit rootDir → OPENSQUID_HOME → LOOP_HOME → ~/.opensquid
 */
export function resolveDataRoot(rootDir?: string): string {
  if (rootDir) return rootDir;
  if (process.env.OPENSQUID_HOME) return process.env.OPENSQUID_HOME;
  if (process.env.LOOP_HOME) return process.env.LOOP_HOME;
  return path.join(os.homedir(), ".opensquid");
}

/** Directory holding all installed codexes. */
export function codexesDir(rootDir?: string): string {
  return path.join(resolveDataRoot(rootDir), "codexes");
}

/** Directory for a specific codex by id. */
export function codexDir(id: string, rootDir?: string): string {
  return path.join(codexesDir(rootDir), id);
}

// ---------------------------------------------------------------------
// Id validation
// ---------------------------------------------------------------------

const CODEX_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * Validate a codex id: lowercase alphanumeric + `._-`, max 128 chars,
 * cannot start with `._-`. Prevents path traversal and ambiguous names.
 */
export function validateCodexId(id: string): void {
  if (!CODEX_ID_RE.test(id)) {
    throw new CodexStoreError(
      "INVALID_ID",
      `codex id "${id}" is invalid (must match /^[a-z0-9][a-z0-9._-]{0,127}$/)`,
    );
  }
}

// ---------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CodexStoreError("READ_FAILED", `read failed: ${filePath}`, err);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Install a codex into local storage.
 *
 * Writes `codex.yaml` at the canonical path. If `force=false` and a
 * codex with this id is already installed, throws ALREADY_INSTALLED.
 */
export async function installCodex(
  codex: Codex,
  options: { rootDir?: string; force?: boolean } = {},
): Promise<{ id: string; path: string }> {
  validateCodexId(codex.id);
  const dir = codexDir(codex.id, options.rootDir);
  const manifestPath = path.join(dir, "codex.yaml");

  if (!options.force && (await pathExists(manifestPath))) {
    throw new CodexStoreError(
      "ALREADY_INSTALLED",
      `codex "${codex.id}" is already installed at ${dir} (use force to overwrite)`,
    );
  }

  try {
    await ensureDir(dir);
    const yaml = stringifyYaml(codex);
    await fs.writeFile(manifestPath, yaml, "utf8");
  } catch (err) {
    throw new CodexStoreError("WRITE_FAILED", `failed to write codex "${codex.id}"`, err);
  }

  return { id: codex.id, path: dir };
}

/**
 * Load an installed codex by id.
 *
 * Reads + parses `codex.yaml`. Throws NOT_FOUND if not installed, or
 * PARSE_FAILED if the manifest is malformed.
 */
export async function getCodex(id: string, options: { rootDir?: string } = {}): Promise<Codex> {
  validateCodexId(id);
  const manifestPath = path.join(codexDir(id, options.rootDir), "codex.yaml");
  const content = await readIfExists(manifestPath);
  if (content === null) {
    throw new CodexStoreError("NOT_FOUND", `codex "${id}" not installed at ${manifestPath}`);
  }
  try {
    return parseCodexYaml(content);
  } catch (err) {
    throw new CodexStoreError("PARSE_FAILED", `codex "${id}" manifest is malformed`, err);
  }
}

/**
 * List all installed codex ids.
 *
 * Scans `<root>/codexes/` for directories that contain a `codex.yaml`.
 * Directories without a manifest are skipped (partial installs, etc.).
 * Returns ids in sorted order.
 */
export async function listCodexes(options: { rootDir?: string } = {}): Promise<string[]> {
  const dir = codexesDir(options.rootDir);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new CodexStoreError("READ_FAILED", `failed to list codexes at ${dir}`, err);
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!CODEX_ID_RE.test(entry.name)) continue;
    const manifest = path.join(dir, entry.name, "codex.yaml");
    if (await pathExists(manifest)) {
      ids.push(entry.name);
    }
  }
  ids.sort();
  return ids;
}

/**
 * Remove an installed codex.
 *
 * Deletes the entire `<root>/codexes/<id>/` directory. Returns true if
 * the codex existed and was removed; false if it wasn't installed.
 * Does NOT touch the engine's lesson store — the caller is responsible
 * for retiring the codex's seeded lessons via the engine RPC first.
 */
export async function removeCodex(
  id: string,
  options: { rootDir?: string } = {},
): Promise<boolean> {
  validateCodexId(id);
  const dir = codexDir(id, options.rootDir);
  if (!(await pathExists(dir))) return false;
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    throw new CodexStoreError("WRITE_FAILED", `failed to remove codex "${id}"`, err);
  }
}

/**
 * Resolve the path to a content file (lesson body, reference doc) inside
 * a codex. Used by the orchestrator when bank_strategy requires lazy
 * fetching the full body. Does NOT read the file — just returns the path.
 */
export function codexContentPath(
  id: string,
  relativePath: string,
  options: { rootDir?: string } = {},
): string {
  validateCodexId(id);
  // Refuse paths that try to escape the codex dir.
  const dir = codexDir(id, options.rootDir);
  const resolved = path.resolve(dir, relativePath);
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) {
    throw new CodexStoreError("INVALID_ID", `relative path "${relativePath}" escapes codex root`);
  }
  return resolved;
}

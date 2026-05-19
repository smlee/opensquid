/**
 * Opensquid host-level config at `<data-root>/config.json`.
 *
 * Persists machine-state that's relevant across sessions but doesn't
 * belong in per-project files or in the engine's lesson store. v0.4
 * uses it to remember the engine binary path so moving the loop-engine
 * checkout doesn't silently break opensquid.
 *
 * Resolution order for the engine binary (v0.6c):
 *   1. `OPENSQUID_ENGINE_BIN` env var — explicit override, always wins
 *   2. `<data-root>/config.json` `engine_bin` field — persisted choice
 *   3. Bundled npm optional dep (`opensquid-engine-<platform>-<arch>`) —
 *      shipped with `opensquid` for published installs (v0.6c)
 *   4. Auto-search common dev paths (~/projects/{,*}/{loop/engine,engine}/target/release/loop-engine)
 *   5. `loop-engine` on $PATH (manually-installed binary)
 *   6. `null` — caller surfaces a helpful error
 *
 * The first successful resolution writes itself back to config.json so
 * the next session picks up the same path immediately. Bundled-binary
 * hits are NOT persisted to config because the path is deterministic
 * from the npm install layout — re-resolving is free and stale-safe
 * across opensquid upgrades.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveDataRoot } from "./codex/store.js";
import { resolveBundledEngineBin } from "./engine-binary-resolver.js";

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------

export interface OpensquidConfig {
  version: 1;
  /** Last-known path to the loop-engine binary. */
  engine_bin?: string;
  /** ISO timestamp the engine_bin was last resolved. */
  engine_bin_resolved_at?: string;
}

const DEFAULT_CONFIG: OpensquidConfig = { version: 1 };

// ---------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------

function configPath(dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "config.json");
}

export async function loadConfig(dataRoot?: string): Promise<OpensquidConfig> {
  try {
    const raw = await fs.readFile(configPath(dataRoot), "utf8");
    const parsed = JSON.parse(raw) as OpensquidConfig;
    if (parsed && parsed.version === 1) return parsed;
  } catch {
    // missing or malformed — return default
  }
  return { ...DEFAULT_CONFIG };
}

export async function saveConfig(config: OpensquidConfig, dataRoot?: string): Promise<void> {
  const p = configPath(dataRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------
// Engine binary discovery
// ---------------------------------------------------------------------

const ENGINE_BIN_NAME = "loop-engine";

/**
 * Resolve the engine binary path using the priority chain above.
 * Writes the resolved path back to config when discovered via search
 * so the next session is instant.
 *
 * Returns `null` if no working binary could be located.
 */
export async function resolveEngineBin(dataRoot?: string): Promise<string | null> {
  // 1. Env override always wins. Don't validate — let the spawn fail
  //    loudly if the user gave a bad path.
  const fromEnv = process.env.OPENSQUID_ENGINE_BIN?.trim();
  if (fromEnv) return fromEnv;

  // 2. Persisted choice.
  const config = await loadConfig(dataRoot);
  if (config.engine_bin && (await isExecutable(config.engine_bin))) {
    return config.engine_bin;
  }

  // 3. v0.6c: bundled npm optional dependency. Only present in npm
  //    installs of `opensquid` once we start publishing the engine
  //    binary packages. Returns null in local-dev / git-clone setups,
  //    so the older discovery branches still cover that case. We
  //    intentionally do NOT persist this to config.json — the path is
  //    deterministic from the npm layout, and persisting it would
  //    point at a stale node_modules path after upgrades.
  const bundled = resolveBundledEngineBin();
  if (bundled && (await isExecutable(bundled))) {
    return bundled;
  }

  // 4. Auto-search common dev paths.
  const found = await searchCommonPaths();
  if (found) {
    config.engine_bin = found;
    config.engine_bin_resolved_at = new Date().toISOString();
    await saveConfig(config, dataRoot);
    return found;
  }

  // 5. $PATH (in case the user installed loop-engine system-wide).
  const onPath = await whichBinary(ENGINE_BIN_NAME);
  if (onPath) {
    config.engine_bin = onPath;
    config.engine_bin_resolved_at = new Date().toISOString();
    await saveConfig(config, dataRoot);
    return onPath;
  }

  return null;
}

/**
 * Set the engine binary path explicitly and persist. Validates that the
 * path points at an executable file before writing.
 */
export async function setEngineBin(
  binPath: string,
  dataRoot?: string,
): Promise<{ resolved: string }> {
  const abs = path.resolve(binPath);
  if (!(await isExecutable(abs))) {
    throw new Error(`not an executable file: ${abs}`);
  }
  const config = await loadConfig(dataRoot);
  config.engine_bin = abs;
  config.engine_bin_resolved_at = new Date().toISOString();
  await saveConfig(config, dataRoot);
  return { resolved: abs };
}

/**
 * Forget the persisted engine binary path. Forces re-discovery on the
 * next `resolveEngineBin` call.
 */
export async function forgetEngineBin(dataRoot?: string): Promise<void> {
  const config = await loadConfig(dataRoot);
  delete config.engine_bin;
  delete config.engine_bin_resolved_at;
  await saveConfig(config, dataRoot);
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

async function isExecutable(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return false;
    // Best-effort executable check: mode &  0o111 (any-x bit set).
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Walk common dev-machine layouts looking for a release binary.
 * Conservative — only checks paths that look like sibling projects of
 * the user's $HOME. Returns the first hit.
 */
async function searchCommonPaths(): Promise<string | null> {
  const home = os.homedir();
  const candidates: string[] = [];

  // ~/projects/<*>/engine/target/release/loop-engine — checkout of a
  // workspace named anything; engine/ as the substrate subdir.
  // ~/projects/<*>/target/release/loop-engine — standalone engine repo.
  const projectsRoot = path.join(home, "projects");
  try {
    const dirs = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(projectsRoot, entry.name, "engine", "target", "release", ENGINE_BIN_NAME),
        path.join(projectsRoot, entry.name, "target", "release", ENGINE_BIN_NAME),
      );
    }
  } catch {
    // ~/projects doesn't exist — skip.
  }

  // ~/work/<*>/{engine,}/target/release/loop-engine — alternate
  // convention.
  const workRoot = path.join(home, "work");
  try {
    const dirs = await fs.readdir(workRoot, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(workRoot, entry.name, "engine", "target", "release", ENGINE_BIN_NAME),
        path.join(workRoot, entry.name, "target", "release", ENGINE_BIN_NAME),
      );
    }
  } catch {
    // ~/work doesn't exist — skip.
  }

  for (const cand of candidates) {
    if (await isExecutable(cand)) return cand;
  }
  return null;
}

/**
 * Cross-platform `which` — search $PATH for an executable named `bin`.
 * Returns absolute path or null.
 */
async function whichBinary(bin: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

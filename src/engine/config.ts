/**
 * Engine binary discovery + persisted-path management.
 *
 * Resolution chain (per T.1 audit §J + src.legacy precedent):
 *   1. `OPENSQUID_ENGINE_BIN` env var — explicit override, always wins
 *   2. `~/.opensquid/engine-config.json` `engine_bin` field — persisted choice
 *   3. Bundled npm optional dep (`opensquid-engine-<platform>-<arch>`)
 *      — returns `null` until npm stubs ship (follow-up track)
 *   4. Auto-search dev paths under `~/projects/*` and `~/work/*`
 *   5. `loop-engine` on `$PATH`
 *   6. `null` — caller surfaces a helpful error
 *
 * First successful resolution from (4) or (5) is persisted to
 * `~/.opensquid/engine-config.json` so the next session skips the search.
 * Bundled-binary hits (3) are NOT persisted because the path is
 * deterministic from the npm install layout and persisting it would
 * point at a stale `node_modules/` path after upgrades.
 *
 * The persisted file is engine-specific so it doesn't collide with the
 * existing `~/.opensquid/config.json` written by the chat-daemon stack.
 *
 * Imports `OPENSQUID_HOME` from `runtime/paths.ts` so the data root
 * honors the `OPENSQUID_HOME` env override (tests + relocatable installs).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { OPENSQUID_HOME } from '../runtime/paths.js';

import { resolveBundledEngineBin } from './resolver.js';

const ENGINE_BIN_NAME = 'loop-engine';
const ENGINE_CONFIG_FILE = 'engine-config.json';

export interface EngineConfig {
  version: 1;
  /** Last-known path to the loop-engine binary. */
  engine_bin?: string;
  /** ISO timestamp the engine_bin was last resolved via search. */
  engine_bin_resolved_at?: string;
}

const DEFAULT_CONFIG: EngineConfig = { version: 1 };

function engineConfigPath(): string {
  return path.join(OPENSQUID_HOME(), ENGINE_CONFIG_FILE);
}

export async function loadEngineConfig(): Promise<EngineConfig> {
  try {
    const raw = await fs.readFile(engineConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as EngineConfig;
    if (parsed.version === 1) return parsed;
  } catch {
    // missing or malformed — return default
  }
  return { ...DEFAULT_CONFIG };
}

export async function saveEngineConfig(config: EngineConfig): Promise<void> {
  const p = engineConfigPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Resolve the engine binary path using the priority chain above. Writes
 * the resolved path back to config when discovered via search so the
 * next session is instant. Returns `null` if no working binary could be
 * located.
 *
 * **Re-resolution on every start** (T.7 / T.1.P): a persisted
 * `engine_bin` that no longer points at an executable file is cleared
 * from the config and the resolver falls through to bundled → dev →
 * `$PATH`. This adds ~10-100ms (one extra `fs.stat`) but means a
 * deleted / moved / freshly-rebuilt binary silently self-heals on the
 * next start instead of failing loudly with `ENOENT`. Bundled hits
 * are NOT persisted (deterministic from npm layout); dev-path + `$PATH`
 * hits ARE persisted so subsequent sessions skip the search.
 */
export async function resolveEngineBin(): Promise<string | null> {
  const fromEnv = process.env.OPENSQUID_ENGINE_BIN?.trim();
  if (fromEnv) return fromEnv;

  let config = await loadEngineConfig();
  if (config.engine_bin) {
    if (await isExecutable(config.engine_bin)) {
      return config.engine_bin;
    }
    // Stale persisted path (binary deleted / moved / chmod -x).
    // Clear + persist so subsequent calls don't repeat the stat.
    delete config.engine_bin;
    delete config.engine_bin_resolved_at;
    await saveEngineConfig(config);
    // Reload so the in-memory `config` matches what's on disk before
    // the success-branch writes below mutate + save again.
    config = await loadEngineConfig();
  }

  const bundled = resolveBundledEngineBin();
  if (bundled && (await isExecutable(bundled))) {
    // Do NOT persist — the npm layout determines this deterministically
    // and persisting a `node_modules/` path makes upgrades hostile.
    return bundled;
  }

  const found = await searchCommonPaths();
  if (found) {
    config.engine_bin = found;
    config.engine_bin_resolved_at = new Date().toISOString();
    await saveEngineConfig(config);
    return found;
  }

  const onPath = await whichBinary(ENGINE_BIN_NAME);
  if (onPath) {
    config.engine_bin = onPath;
    config.engine_bin_resolved_at = new Date().toISOString();
    await saveEngineConfig(config);
    return onPath;
  }

  return null;
}

/**
 * Set the engine binary path explicitly and persist. Validates that the
 * path points at an executable file before writing.
 */
export async function setEngineBin(binPath: string): Promise<{ resolved: string }> {
  const abs = path.resolve(binPath);
  if (!(await isExecutable(abs))) {
    throw new Error(`not an executable file: ${abs}`);
  }
  const config = await loadEngineConfig();
  config.engine_bin = abs;
  config.engine_bin_resolved_at = new Date().toISOString();
  await saveEngineConfig(config);
  return { resolved: abs };
}

/**
 * Forget the persisted engine binary path. Forces re-discovery on the
 * next `resolveEngineBin` call.
 */
export async function forgetEngineBin(): Promise<void> {
  const config = await loadEngineConfig();
  delete config.engine_bin;
  delete config.engine_bin_resolved_at;
  await saveEngineConfig(config);
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return false;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Walk common dev-machine layouts looking for a release binary.
 * Conservative — only checks paths that look like sibling projects of
 * the user's `$HOME`. Returns the first hit.
 *
 * Covered layouts:
 *   ~/projects/<*>/engine/target/release/loop-engine   (loop workspace)
 *   ~/projects/<*>/target/release/loop-engine          (standalone engine repo)
 *   ~/work/<*>/{engine,}/target/release/loop-engine    (alt convention)
 */
async function searchCommonPaths(): Promise<string | null> {
  const home = os.homedir();
  const candidates: string[] = [];

  const projectsRoot = path.join(home, 'projects');
  try {
    const dirs = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(projectsRoot, entry.name, 'engine', 'target', 'release', ENGINE_BIN_NAME),
        path.join(projectsRoot, entry.name, 'target', 'release', ENGINE_BIN_NAME),
      );
    }
  } catch {
    // ~/projects doesn't exist — skip.
  }

  const workRoot = path.join(home, 'work');
  try {
    const dirs = await fs.readdir(workRoot, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      candidates.push(
        path.join(workRoot, entry.name, 'engine', 'target', 'release', ENGINE_BIN_NAME),
        path.join(workRoot, entry.name, 'target', 'release', ENGINE_BIN_NAME),
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
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

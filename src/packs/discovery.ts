/**
 * Active-pack discovery — scan a scope root for `active.json` + `codexes/<name>/`.
 *
 * G.1 wires the real loader path. Given a scope root (either user-scope from
 * `resolveUserScopeRoot()` or project-scope from `resolveProjectScopeRoot(cwd)`),
 * this module:
 *
 *   1. Reads `<scopeRoot>/active.json` — schema `{ packs: string[] }`.
 *   2. For each entry, loads `<scopeRoot>/codexes/<name>/` through the
 *      existing `loadPack` (Phase-2 pack format: `manifest.yaml` + `skills/`).
 *
 * Behavior contract:
 *   - `scopeRoot === null`           → returns `[]` (project absent case).
 *   - `active.json` ENOENT           → returns `[]` (scope present, no opt-in).
 *   - `active.json` malformed JSON   → throws path-bearing error.
 *   - `active.json` missing `packs:` → throws with clear "missing field" message.
 *   - `active.json` references a pack folder that doesn't exist or fails to
 *     load → `loadPack` throws; we propagate verbatim.
 *
 * Fail-loud is intentional per `project_opensquid_runtime_failure_handling`
 * memory: a user-authored config bug must surface, not silent-fail to the
 * "allow everything" path. The two test seams in `bootstrap.ts`
 * (`OPENSQUID_TEST_PACK`, `OPENSQUID_TEST_PACK_DIR`) keep their own
 * fail-open contracts because their fixtures are opensquid-authored, not
 * user-authored.
 *
 * Harness-agnostic: this module knows nothing about Claude Code, hook
 * formats, or any consumer-side concept. The settings-writer that lives in
 * `src/setup/wizard/` is the ONLY G.1 module that names the consumer.
 *
 * Imports from: node:fs/promises, node:path, packs/loader.
 * Imported by: src/runtime/bootstrap.ts (the real loader path).
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { Pack } from '../runtime/types.js';

import { loadPack } from './loader.js';

export interface ActiveJson {
  /** Pack names (folder names under `codexes/`) declared active in this scope. */
  packs: string[];
}

/**
 * Scan a scope root for active packs. See module header for the full
 * contract; in short: returns `[]` on the two "scope-absent" branches
 * (`null` arg, ENOENT active.json) and throws on anything malformed.
 */
export async function discoverActivePacks(scopeRoot: string | null): Promise<Pack[]> {
  if (scopeRoot === null) return [];

  const activePath = join(scopeRoot, 'active.json');
  let active: ActiveJson;
  try {
    const raw = await fs.readFile(activePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`opensquid: failed to parse ${activePath} as JSON: ${(e as Error).message}`);
    }
    active = parsed as ActiveJson;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }

  if (!Array.isArray(active.packs)) {
    throw new Error(`opensquid: ${activePath} missing required "packs": string[] field`);
  }
  // Validate every entry is a non-empty string before we touch the disk —
  // surfacing a stringly-typed error here is more actionable than the
  // ENOENT loadPack would surface if we passed `undefined` through join().
  for (const [i, name] of active.packs.entries()) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`opensquid: ${activePath} "packs[${String(i)}]" is not a non-empty string`);
    }
  }

  const codexesDir = join(scopeRoot, 'codexes');
  const packs: Pack[] = [];
  for (const name of active.packs) {
    packs.push(await loadPack(join(codexesDir, name)));
  }
  return packs;
}

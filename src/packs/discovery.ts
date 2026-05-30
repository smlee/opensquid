/**
 * Active-pack discovery — scan a scope root for `active.json` + `packs/<name>/`.
 *
 * G.1 wires the real loader path. Given a scope root (either user-scope from
 * `resolveUserScopeRoot()` or project-scope from `resolveProjectScopeRoot(cwd)`),
 * this module:
 *
 *   1. Reads `<scopeRoot>/active.json` — schema `{ packs: string[] }`.
 *   2. For each entry, loads `<scopeRoot>/packs/<name>/` through the
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

import { matchesDetectedBy, type DetectionContext } from '../runtime/detection.js';
import type { Pack } from '../runtime/types.js';

import { expandComposites } from './composite_resolver.js';
import { loadPack } from './loader.js';

export interface ActiveJson {
  /** Pack names (folder names under `packs/`) declared active in this scope. */
  packs: string[];
}

/**
 * Scan a scope root for active packs. See module header for the full
 * contract; in short: returns `[]` on the two "scope-absent" branches
 * (`null` arg, ENOENT active.json) and throws on anything malformed.
 *
 * IDF.3 — optional `ctx` second arg gates loading on the per-pack
 * `detected_by[]` rules via IDF.2's pure evaluator. When `ctx` is
 * `null`/`undefined`, legacy behavior applies (every opted-in pack
 * loads). When `ctx` is provided, each opted-in pack only loads if its
 * `detectedBy` matches the staged context (empty `detectedBy[]` always
 * matches — back-compat). Opt-in invariant preserved end-to-end: a pack
 * NOT listed in `active.json` is never loaded by this fn, regardless of
 * what its `detectedBy` would say.
 */
export async function discoverActivePacks(
  scopeRoot: string | null,
  ctx: DetectionContext | null = null,
): Promise<Pack[]> {
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

  // T-PACK-VOCAB L2 (2026-05-29) — backward-compat: prefer `<scope>/packs/`
  // but fall back to the legacy `<scope>/codexes/` path with a deprecation
  // warn. Users migrate at their own pace by `mv codexes/ packs/`.
  const preferredDir = join(scopeRoot, 'packs');
  const legacyDir = join(scopeRoot, 'codexes');
  const dirs = await resolvePacksDir(preferredDir, legacyDir);
  const packs: Pack[] = [];
  for (const name of active.packs) {
    const pack = await loadPack(join(dirs, name));
    if (ctx === null || matchesDetectedBy(pack.detectedBy ?? [], ctx)) {
      packs.push(pack);
    }
  }
  // MM.1 (2026-05-30) — expand composite packs into their includes after
  // per-pack detected_by gating. Composite identity is preserved (the
  // composite stays in the list for audit); its included focused packs are
  // appended (deduped first-occurrence-wins). Errors throw
  // CompositeResolutionError with the composite name + cause.
  return expandComposites(packs);
}

/**
 * T-PACK-VOCAB L2 — resolve which root dir to use for pack folder lookup.
 * Returns the preferred `packs/` dir when it exists; otherwise falls back to
 * the legacy `codexes/` dir with a stderr deprecation warning. If neither
 * exists, returns the preferred dir (loadPack will surface the missing-folder
 * error with a sensible path).
 */
async function resolvePacksDir(preferred: string, legacy: string): Promise<string> {
  try {
    await fs.stat(preferred);
    return preferred;
  } catch {
    // preferred missing; check legacy
  }
  try {
    await fs.stat(legacy);
    process.stderr.write(
      `opensquid: \`codexes/\` is deprecated as the pack-folder root; ` +
        `please \`mv ${legacy} ${preferred}\` (T-PACK-VOCAB)\n`,
    );
    return legacy;
  } catch {
    // neither exists; return preferred — loadPack's per-name join will
    // surface the missing-folder error with a useful path.
    return preferred;
  }
}

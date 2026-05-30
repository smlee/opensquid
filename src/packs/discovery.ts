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
import { homedir } from 'node:os';
import { join } from 'node:path';

import { matchesDetectedBy, type DetectionContext } from '../runtime/detection.js';
import type { Pack } from '../runtime/types.js';
import { runThreeWayMerge, type MergeResult } from '../runtime/versioning.js';

import { expandComposites } from './composite_resolver.js';
import { loadPack } from './loader.js';
import { readVersionJson } from './personal_revision.js';

/**
 * LP.5 — module-scoped per-session merge cache. Cleared by bootstrap on
 * SessionStart via `clearMergeCache()`. Key is the (packId, baseVersion,
 * vanillaVersion, personalRevisionId) tuple — when ANY of those change the
 * cache is invalid.
 */
const mergeCache = new Map<string, MergeResult>();

interface MergeCacheKey {
  packId: string;
  baseVersion: string;
  vanillaVersion: string;
  personalRevisionId: number;
}

function cacheKey(k: MergeCacheKey): string {
  return `${k.packId}@base=${k.baseVersion}@vanilla=${k.vanillaVersion}@rev=${String(k.personalRevisionId)}`;
}

/** LP.5 — bootstrap calls this on SessionStart to clear per-session cache. */
export function clearMergeCache(): void {
  mergeCache.clear();
}

/** LP.5 — exposed for tests to peek cached count. */
export function _mergeCacheSize(): number {
  return mergeCache.size;
}

function semverLtLocal(a: string, b: string): boolean {
  const ap = a
    .split('-')[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10));
  const bp = b
    .split('-')[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const d = (ap[i] ?? 0) - (bp[i] ?? 0);
    if (d < 0) return true;
    if (d > 0) return false;
  }
  return false;
}

/**
 * LP.5 — lazy 3-way merge trigger. For an installed pack at `packStateDir`,
 * check whether the on-disk vanilla is newer than the recorded base AND has
 * lessons to preserve AND hasn't been merged yet. If so, trigger LP.2's
 * runThreeWayMerge against the vanilla source (passed in as `vanillaDir`).
 *
 * Cached per-session — same (packId, base, vanilla, revisionId) tuple
 * resolves once per session lifetime.
 *
 * Returns null in any skip-merge case (not installed, no lessons, already
 * merged, not an upgrade). Returns the MergeResult when the merge actually
 * runs.
 *
 * Per L10 LAZY: NO background poller; this fires on next discovery only.
 * Per L11 IMMUTABLE base_version: only `last_merged_vanilla` mutates;
 * base_version stays the install-time value.
 */
export async function checkAndMergeUpgrades(
  packStateDir: string,
  vanillaManifest: { name: string; version: string },
  vanillaDir: string,
): Promise<MergeResult | null> {
  const version = await readVersionJson(packStateDir);
  if (version === null) return null;
  if (version.personal_revision_id === 0) return null;
  if (version.last_merged_vanilla === vanillaManifest.version) return null;
  if (!semverLtLocal(version.base_version, vanillaManifest.version)) return null;

  const key = cacheKey({
    packId: vanillaManifest.name,
    baseVersion: version.base_version,
    vanillaVersion: vanillaManifest.version,
    personalRevisionId: version.personal_revision_id,
  });
  const cached = mergeCache.get(key);
  if (cached !== undefined) return cached;

  const result = await runThreeWayMerge({
    packId: vanillaManifest.name,
    baseDir: join(packStateDir, 'base'),
    personalStateDir: packStateDir,
    vanillaDir,
    vanillaVersion: vanillaManifest.version,
  });
  mergeCache.set(key, result);
  return result;
}

/**
 * LP.3 — path-traversal-safe validator for pack ids that come from
 * potentially-untrusted sources (manifest.yaml name field, CLI input).
 * Rejects ids containing `/`, `\`, `..`, or starting with `.`. Use before
 * any path construction with the id.
 */
export function validatePackId(packId: string): void {
  if (packId.length === 0) throw new Error('validatePackId: empty packId');
  if (packId.startsWith('.')) throw new Error(`validatePackId: packId may not start with "."`);
  if (/[\\/]|\.\./.test(packId)) {
    throw new Error(`validatePackId: packId "${packId}" contains path-traversal characters`);
  }
}

/**
 * LP.3 — resolve the on-disk state directory for a pack by id. User scope:
 * `~/.opensquid/packs/<id>/`. Project scope: `<projectCwd>/.opensquid/
 * packs/<id>/` (projectCwd required). Path resolver only; does NOT verify
 * directory exists. Caller mkdir-recursive before writing.
 *
 * Honors OPENSQUID_HOME env override (tests). validatePackId is called
 * before path construction.
 */
export function resolvePackStateDir(
  packId: string,
  scope: 'user' | 'project' = 'user',
  projectCwd?: string,
): string {
  validatePackId(packId);
  if (scope === 'project') {
    if (projectCwd === undefined || projectCwd.length === 0) {
      throw new Error('resolvePackStateDir: projectCwd required for project scope');
    }
    return join(projectCwd, '.opensquid', 'packs', packId);
  }
  const home = process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid');
  return join(home, 'packs', packId);
}

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

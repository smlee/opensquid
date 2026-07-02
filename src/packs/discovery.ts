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
import { OPENSQUID_HOME } from '../runtime/paths.js';
import { join } from 'node:path';

import { matchesDetectedBy, type DetectionContext } from '../runtime/detection.js';
import type { Pack } from '../runtime/types.js';
import { runThreeWayMerge, type MergeResult } from '../runtime/versioning.js';

import { expandComposites } from './composite_resolver.js';
import { loadPack } from './loader.js';
import { loadPackV2, type LoadedPackV2 } from './loader_v2.js';
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
  const home = OPENSQUID_HOME();
  return join(home, 'packs', packId);
}

export interface ActiveJson {
  /** Pack names (folder names under `packs/`) declared active in this scope. */
  packs: string[];
  /**
   * PROJECT-SCOPE isolation switch. When `true` in a PROJECT `active.json`, the live pack set is THIS
   * scope's declared packs ONLY — the resolver skips the user-scope (`~/.opensquid`) union AND the synthetic
   * project-context pack (`loadActivePacksForDispatch`). Lets one project run a pure, isolated pack set (e.g.
   * testing v2 fullstack-flow alone) WITHOUT editing the home config, so OTHER projects are unaffected (the
   * flag lives only in this project's active.json; the resolver default is the union). Absent/false → the
   * default user∪project union. Only meaningful at project scope.
   */
  exclusive?: boolean;
  /**
   * DBL.1b — the per-project DEPLOY verification command (e.g. `pnpm typecheck && pnpm test && pnpm build`).
   * The fullstack-flow deploy `verify` decision routes on whether THIS command passed: the deploy procedure runs
   * exactly this command, a PostToolUse reaction records its real exit code (verification.ts), and `deployClean`
   * reads it. ABSENT ⇒ no verification configured ⇒ `deployClean` SKIPs to true (the project ships as today).
   */
  verifyCommand?: string;
  /**
   * REVERSIBLE-DEPLOY — when `true`, the project's deploy is reversible (e.g. a feature-flag roll-out, a
   * preview-channel push, a staged infra change with an instant rollback path). A reversible deploy auto-advances
   * the `accept` decision to `accepted` without a human `opensquid accept <taskId>` (the acceptance audit item
   * is still created — the trail is preserved). ABSENT/false (default) ⇒ IRREVERSIBLE ⇒ human gate required.
   * FAIL-CLOSED: unknown or absent ⇒ irreversible ⇒ the human must accept.
   */
  reversible?: boolean;
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
/** One active pack resolved+loaded by FORMAT. FAC-CUT.5a: v2 subsumes v1 (user decision); the format is
 *  the file present in the resolved dir — `pack.yaml` (v2) vs `manifest.yaml` (v1). */
type ActiveEntry = { format: 'v1'; pack: Pack } | { format: 'v2'; loaded: LoadedPackV2 };

/**
 * FAC-CUT.5a — resolve+load ONE active pack by name, scope-first then builtin, by an open-and-catch where
 * the successful LOAD is the format classification (mirrors the prior fallback loader's
 * open-and-catch-ENOENT, which this replaces): a dir's `pack.yaml` ⇒ v2; else its `manifest.yaml` ⇒ v1; neither at
 * a base ⇒ next base; none ⇒ throw. Only an ENOENT advances the search — a MALFORMED pack (non-ENOENT, e.g.
 * a bad YAML or a failed `PackV2.parse`) propagates (fail-loud, never silently skipped).
 */
async function loadActiveEntry(
  name: string,
  scopePacksDir: string,
  builtinRoot: string | null,
): Promise<ActiveEntry> {
  const bases = builtinRoot === null ? [scopePacksDir] : [scopePacksDir, builtinRoot];
  for (const base of bases) {
    const dir = join(base, name);
    try {
      return { format: 'v2', loaded: await loadPackV2(dir) }; // reads pack.yaml; ENOENT → try v1
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // malformed v2 → fail loud
    }
    try {
      return { format: 'v1', pack: await loadPack(dir) }; // reads manifest.yaml; ENOENT → next base
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // malformed v1 → fail loud
    }
  }
  const tried =
    builtinRoot === null
      ? join(scopePacksDir, name)
      : `${join(scopePacksDir, name)} OR built-in (${join(builtinRoot, name)})`;
  throw new Error(
    `opensquid: pack "${name}" listed in active.json was not found (v2 pack.yaml or v1 manifest.yaml) at ` +
      `${tried}. Either install the pack via \`opensquid pack install\` or drop the entry from active.json.`,
  );
}

/**
 * FAC-CUT.5a — single-pass partition of the active packs into v1 + v2 by `pack.yaml` presence. Every active
 * name is resolved+loaded ONCE via `loadActiveEntry`; v1 entries keep the `detectedBy` gate + composite
 * expansion (unchanged), v2 entries are collected raw (their `detected_by`/composite parity is FAC-CUT.5b).
 * `discoverActivePacks` is the thin `.v1` wrapper below, so the v1 `Pack[]` consumer graph is untouched.
 */
export async function partitionActivePacks(
  scopeRoot: string | null,
  ctx: DetectionContext | null = null,
  builtinRoot: string | null = null,
): Promise<{ v1: Pack[]; v2: LoadedPackV2[] }> {
  if (scopeRoot === null) return { v1: [], v2: [] };

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
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { v1: [], v2: [] };
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

  // Pack folders live under `<scope>/packs/`. (The legacy `<scope>/codexes/`
  // fallback was removed in T-CHAT-AS-TERMINAL's codex→pack standardization —
  // `packs/` is the sole, standard layout.)
  const packsDir = join(scopeRoot, 'packs');
  const v1: Pack[] = [];
  const v2: LoadedPackV2[] = [];
  for (const name of active.packs) {
    const entry = await loadActiveEntry(name, packsDir, builtinRoot);
    if (entry.format === 'v2') {
      v2.push(entry.loaded);
    } else if (ctx === null || matchesDetectedBy(entry.pack.detectedBy ?? [], ctx)) {
      v1.push(entry.pack);
    }
  }
  // MM.1 (2026-05-30) — expand composite packs into their includes after
  // per-pack detected_by gating. Composite identity is preserved (the
  // composite stays in the list for audit); its included focused packs are
  // appended (deduped first-occurrence-wins). Errors throw
  // CompositeResolutionError with the composite name + cause.
  return { v1: expandComposites(v1), v2 };
}

/**
 * The active v1 packs in this scope. UNCHANGED public contract (`Pack[]`, same signature) — a thin wrapper
 * over `partitionActivePacks(...).v1`, so every caller (`realPacksPromise` + the ~13 `Pack[]` consumers) is
 * untouched while the single-pass partition runs underneath (FAC-CUT.5a). See the module header for the
 * behavior contract (still exact for the v1 path).
 */
export async function discoverActivePacks(
  scopeRoot: string | null,
  ctx: DetectionContext | null = null,
  builtinRoot: string | null = null,
): Promise<Pack[]> {
  return (await partitionActivePacks(scopeRoot, ctx, builtinRoot)).v1;
}

/**
 * Read the `exclusive` switch from a scope's `active.json` (the project-scope isolation flag, see
 * {@link ActiveJson.exclusive}). `true` ⇒ this scope runs in isolation (the caller skips the user-scope
 * union). Lenient: absent scope / ENOENT / any read-or-parse fault → `false` (the safe default = the normal
 * union); a genuinely malformed `active.json` still fails LOUD at the `partitionActivePacks` read that runs
 * alongside this, so a config bug is never silently swallowed here.
 */
export async function readActiveExclusive(scopeRoot: string | null): Promise<boolean> {
  if (scopeRoot === null) return false;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    return (JSON.parse(raw) as ActiveJson).exclusive === true;
  } catch {
    return false;
  }
}

/**
 * #36 — project-local discipline predicate: does THIS scope's active.json list at least one pack?
 * false when: scopeRoot is null (no .opensquid/ found), active.json absent (ENOENT), or packs empty.
 * Lenient: any read/parse error → false (fail-open). Unlike readActiveExclusive this checks pack presence.
 */
export async function hasActiveProjectPacks(scopeRoot: string | null): Promise<boolean> {
  if (scopeRoot === null) return false;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const json = JSON.parse(raw) as ActiveJson;
    return Array.isArray(json.packs) && json.packs.length > 0;
  } catch {
    return false;
  }
}

/**
 * DBL.1b — read the per-project DEPLOY `verifyCommand` from a scope's `active.json` (see
 * {@link ActiveJson.verifyCommand}), or `null` when absent/unconfigured/unreadable (→ `deployClean` SKIPs to
 * true; the project ships as today). Lenient like {@link readActiveExclusive}.
 */
export async function readActiveVerifyCommand(scopeRoot: string | null): Promise<string | null> {
  if (scopeRoot === null) return null;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const v = (JSON.parse(raw) as ActiveJson).verifyCommand;
    return typeof v === 'string' && v.trim().length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * REVERSIBLE-DEPLOY — read the per-project `deploy.reversible` flag from a scope's `active.json` (see
 * {@link ActiveJson.reversible}). Returns `true` ONLY when the flag is explicitly `true`; all other cases
 * (absent, false, unreadable, malformed) return `false` (FAIL-CLOSED: unknown ⇒ irreversible ⇒ human gate).
 * Mirrors {@link readActiveVerifyCommand}.
 */
export async function readActiveDeployReversible(scopeRoot: string | null): Promise<boolean> {
  if (scopeRoot === null) return false;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const json = JSON.parse(raw) as ActiveJson;
    return json.reversible === true;
  } catch {
    return false; // fail-closed: unreadable / malformed ⇒ treat as irreversible
  }
}

/**
 * BPDISC — Try to load `<name>` from the scope's packs/ dir; if that path
 * doesn't exist, fall back to `<builtinRoot>/<name>/`. The fallback only
 * fires on ENOENT at the manifest level — every other loadPack error
 * (YAML parse, Zod validation, missing skill file) propagates verbatim
 * from the user-scope attempt so the user sees the right blame path.
 *
 * Why a fallback rather than always-search-both: scope-precedence is
 * explicit (user-installed wins over built-in even when names collide),
 * matching the layering contract in pack-runtime.md §1.6.
 */

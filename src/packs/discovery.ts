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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OPENSQUID_HOME } from '../runtime/paths.js';
import { join, dirname } from 'node:path';

const execFileP = promisify(execFile);

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
   * OBSOLETE (retired by project-only operation). This was the project-scope isolation opt-out back when
   * the resolver unioned the user/home scope with the project scope; setting it `true` skipped that union.
   * Under project-only operation the resolver ALREADY loads the project scope ONLY (global enforces
   * nothing), so `exclusive` is a no-op — it is parsed tolerantly (an old active.json carrying it still
   * loads) but has NO effect. The field is retained solely so existing configs keep parsing.
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
   * scope-1 (T-deploy-commit-gate §2.1, §4a) — the per-project VERIFICATION SUITE command: the whole pre-push
   * bar the human's `git push` runs (opensquid's `bash scripts/pre-push.sh` = lint+typecheck+build+test+
   * format:check). This is DEPLOY's MANDATORY FLOOR (`deployClean = suiteGreen && (verifyCommand green OR
   * unconfigured)`), whereas `verifyCommand` is the ADDITIVE e2e/smoke layer on top. The COMMAND itself is
   * PROJECT config (a cargo/pytest project declares its own) — core reads it generically here and carries NO
   * `pre-push.sh` literal (design §4a). ABSENT ⇒ no suite declared ⇒ the floor is skipped (a legacy project
   * ships as today); the fullstack-flow floor only bites once a suite is declared.
   */
  verifySuite?: string;
  /**
   * AQG.4 (T-arch-quality-gate) — the per-project ARCHITECTURE-DETECTOR command: a project-declared check that
   * deterministically fails a mechanical architecture defect (e.g. a redundant-store / duplicate-schema linter).
   * The `code.arch_clean` facet routes on whether THIS command passed: the CODE procedure runs exactly this
   * command, a PostToolUse reaction records its real exit code (verification.ts `recordArch`), and `archClean`
   * reads it. The COMMAND itself is PROJECT policy — core runs a declared command and reads an exit code, it
   * NEVER knows what "redundant store" means (the qualitative criteria live in the rubric, not core). Mirrors
   * {@link verifySuite} EXACTLY except the fail policy: ABSENT ⇒ no detector declared ⇒ `code.arch_clean` fails
   * OPEN to `true` (a legacy project ships as today, mirroring `verifySuite`'s legacy skip); DECLARED ⇒ the
   * facet fails CLOSED (unrun / red → blocks). opensquid itself declares NO detector — the mechanism ships, the
   * concrete detector command is a separate per-project policy choice.
   */
  archDetector?: string;
  /**
   * REVERSIBLE-DEPLOY — when `true`, the project's deploy is reversible (e.g. a feature-flag roll-out, a
   * preview-channel push, a staged infra change with an instant rollback path). A reversible deploy auto-advances
   * the `accept` decision to `accepted` without a human `opensquid accept <taskId>` (the acceptance audit item
   * is still created — the trail is preserved). ABSENT/false (default) ⇒ IRREVERSIBLE ⇒ human gate required.
   * FAIL-CLOSED: unknown or absent ⇒ irreversible ⇒ the human must accept.
   */
  reversible?: boolean;
  /**
   * AGF.1 (T-opensquid-automated-gitflow) — the per-project VERSIONING strategy: DATA in active.json, READ by
   * core, NEVER hardcoded intent-from-commit-type (design §3 step 8). `strategy`/`bump` are single-member unions
   * today (the seams for a future strategy); `prefix` (e.g. "0.5") is the HUMAN-held major.minor the loop NEVER
   * moves — it only bumps the patch (`0.5.N → 0.5.N+1`, `nextLockedTag`). The concrete object is PROJECT config
   * here (mirroring {@link verifySuite}/{@link reversible}); the PACK declares the recommended default so a
   * project that omits it still resolves. ABSENT/malformed ⇒ `readActiveVersioning` → null ⇒ core falls back to
   * the PACK default. SUPERSEDES the naive `bumpLevel`/`nextVersion` (release_semver.ts:39-54) in the automated
   * flow — that intent-from-commit semver is no longer consulted once the locked-prefix path is active.
   */
  versioning?: VersioningConfig;
  /**
   * GF.1 (T-gitflow-integration-fix, scope-1) — the CONFIG-DRIVEN git-flow environments. The whole automated
   * flow derives its branch names from here (presence of `staging` IS the has-stage toggle — no `enabled` flag),
   * so NO core module carries a literal `main`/`stage`. The hyphenated on-disk JSON key is `"version-control"`;
   * a `versionControl` camelCase alias is accepted for forward-friendliness. The locked-prefix `versioning` folds
   * UNDER `version-control` (the top-level {@link versioning} field is KEPT for back-compat read). ABSENT (or a
   * malformed/missing `production`) ⇒ {@link resolveEnvironments} → null ⇒ the project is NOT on the automated
   * git-flow (every routing element skips its hop — mirrors {@link resolveVersioning}→null).
   */
  versionControl?: VersionControlConfig;
}

/**
 * AGF.1 — the declared version strategy shape (see {@link ActiveJson.versioning}). `strategy`/`bump` are
 * single-member unions today — the extension points for a future strategy; `prefix` is the HUMAN-held major.minor.
 */
export interface VersioningConfig {
  strategy: 'locked-prefix';
  prefix: string;
  bump: 'patch-per-release';
}

/**
 * GF.1 (scope-1) — the user-named environment branches. Presence of `staging` IS the has-stage toggle (no
 * `enabled` flag). `production` is REQUIRED (the PR base + the reconcile base). `local`/`staging` optional.
 * Branch-name strings ONLY — no core literal `main`/`stage`.
 */
export interface EnvironmentsConfig {
  production: string;
  staging?: string;
  local?: string;
}

/**
 * GF.1 (scope-1, §3.7.1) — the `version-control` block: the environments plus the locked-prefix `versioning`
 * folded UNDER it (the top-level {@link ActiveJson.versioning} is kept for back-compat read).
 */
export interface VersionControlConfig {
  environments: EnvironmentsConfig;
  versioning?: VersioningConfig;
}

/**
 * GF.1 (scope-1) — the reader's OUTPUT contract that every routing element consumes: `local` is always resolved
 * (to the current branch when unset); `production` is guaranteed present; `staging` present iff configured.
 */
export interface ResolvedEnvironments {
  production: string;
  staging?: string;
  local: string;
}

/**
 * GF.1 (scope-1) — read the RAW `version-control.environments` block from a scope's `active.json`, unvalidated.
 * Accepts the hyphenated on-disk key `"version-control"` or the `versionControl` camelCase alias. Lenient: absent
 * scope / ENOENT / any parse fault → null (a non-automated project). INTERNAL (not exported) — the validated
 * {@link resolveEnvironments} is the public reader.
 */
async function readRawEnvironments(
  scopeRoot: string | null,
): Promise<EnvironmentsConfig | undefined> {
  if (scopeRoot === null) return undefined;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const json = JSON.parse(raw) as ActiveJson & { 'version-control'?: VersionControlConfig };
    return (json['version-control'] ?? json.versionControl)?.environments;
  } catch {
    return undefined; // unreadable / malformed ⇒ not on the automated git-flow
  }
}

/**
 * GF.1 (scope-1, open-Q3) — the deterministic reader every routing element (GF.2/3/4/5/6/7/8) calls. Reads
 * `active.json`'s `version-control.environments`, resolving `local` to `git rev-parse --abbrev-ref HEAD` when
 * absent (the serial landing branch). Returns null when `production` is absent/malformed/unreadable (FAIL-SOFT:
 * an unconfigured project is not on the automated git-flow, mirroring {@link resolveVersioning}→null /
 * {@link readActiveDeployReversible}→false). Presence of `staging` is the ONLY has-stage signal. PURE reads —
 * no mutation.
 */
export async function resolveEnvironments(
  scopeRoot: string | null,
): Promise<ResolvedEnvironments | null> {
  const env = await readRawEnvironments(scopeRoot);
  if (env === undefined || typeof env.production !== 'string' || env.production.length === 0)
    return null;
  const local =
    typeof env.local === 'string' && env.local.length > 0
      ? env.local
      : (
          await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: dirname(scopeRoot!),
          }).catch(() => ({ stdout: 'HEAD' }))
        ).stdout.trim();
  return {
    production: env.production,
    ...(typeof env.staging === 'string' && env.staging.length > 0 ? { staging: env.staging } : {}),
    local,
  };
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
async function loadActiveEntry(name: string, bases: string[]): Promise<ActiveEntry> {
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
  const tried = bases.map((b) => join(b, name)).join(' OR ');
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
  userScopeRoot: string | null = null,
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
  // Pack-NAME resolution order (project-only operation): project scope → user scope → builtin.
  // Only names the project LISTED in its active.json are resolved through this chain. The user scope
  // (`<userScopeRoot>/packs/`) is a SOURCE for an opt-in name that lives only at user scope — e.g. an
  // always-on governance pack such as `sangmin-personal-rules` — NOT an auto-enforcer: a user-scope
  // pack the project did NOT list is never iterated here, so no home∪project union is reintroduced
  // (that union is retired). Builtin is the final supply fallback (a listed-but-uninstalled name).
  // Both `userScopeRoot` and `builtinRoot` are absent (null) in isolated unit paths → project-only.
  const resolutionBases = [packsDir];
  if (userScopeRoot !== null) {
    const userPacksDir = join(userScopeRoot, 'packs');
    if (userPacksDir !== packsDir) resolutionBases.push(userPacksDir);
  }
  if (builtinRoot !== null) resolutionBases.push(builtinRoot);
  const v1: Pack[] = [];
  const v2: LoadedPackV2[] = [];
  for (const name of active.packs) {
    const entry = await loadActiveEntry(name, resolutionBases);
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
  userScopeRoot: string | null = null,
): Promise<Pack[]> {
  return (await partitionActivePacks(scopeRoot, ctx, builtinRoot, userScopeRoot)).v1;
}

/**
 * #36 — project-local discipline predicate: does THIS scope's active.json list at least one pack?
 * false when: scopeRoot is null (no .opensquid/ found), active.json absent (ENOENT), or packs empty.
 * Lenient: any read/parse error → false (fail-open). This is the ONE shared "is discipline active for
 * this cwd project" predicate: the GS1 orchestrator guard consults it directly, and the pack loaders +
 * commit gate key off the SAME project-only `resolveProjectScopeRoot(cwd)` scope so a cwd with no
 * project packs gets zero discipline from every surface.
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
 * true; the project ships as today). Lenient: absent scope / ENOENT / any read-or-parse fault → `null`.
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
 * scope-1 (T-deploy-commit-gate §2.1) — read the per-project VERIFICATION-SUITE command from a scope's
 * `active.json` (see {@link ActiveJson.verifySuite}), or `null` when absent/unconfigured/unreadable (→ the
 * DEPLOY floor is skipped; a legacy project ships as today). Lenient: absent scope / ENOENT / any fault → `null`.
 * Mirrors {@link readActiveVerifyCommand} so core reads the suite command generically (no `pre-push.sh` literal).
 */
export async function readActiveVerifySuite(scopeRoot: string | null): Promise<string | null> {
  if (scopeRoot === null) return null;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const v = (JSON.parse(raw) as ActiveJson).verifySuite;
    return typeof v === 'string' && v.trim().length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * AQG.4 (T-arch-quality-gate) — read the per-project ARCHITECTURE-DETECTOR command from a scope's `active.json`
 * (see {@link ActiveJson.archDetector}), or `null` when absent/unconfigured/unreadable. A byte-for-byte sibling
 * of {@link readActiveVerifySuite}: `null` means NO detector is declared → the `code.arch_clean` facet fails
 * OPEN to `true` (a legacy project ships as today). `scopeRoot` is the `.opensquid` dir already
 * (`resolveProjectScopeRoot`), so `join(scopeRoot, 'active.json')`. Lenient: absent scope / ENOENT / any fault
 * → `null`.
 */
export async function readActiveArchDetector(scopeRoot: string | null): Promise<string | null> {
  if (scopeRoot === null) return null;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const v = (JSON.parse(raw) as ActiveJson).archDetector;
    return typeof v === 'string' && v.trim().length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * AGF.1 (T-opensquid-automated-gitflow) — read the per-project VERSIONING config from a scope's `active.json`
 * (see {@link ActiveJson.versioning}), or `null` when absent/malformed/unreadable (→ core falls back to the PACK
 * default). A byte-for-byte sibling of {@link readActiveVerifySuite} that returns a validated `VersioningConfig`
 * rather than a string: it validates the `locked-prefix` discriminant + a non-empty `prefix`, and defaults `bump`
 * to `patch-per-release`. Lenient: absent scope / ENOENT / any parse fault → `null`. Core carries NO prefix
 * literal — the `0.5` default lives in the PACK; this reads the concrete project object.
 */
export async function readActiveVersioning(
  scopeRoot: string | null,
): Promise<VersioningConfig | null> {
  if (scopeRoot === null) return null;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const v = (JSON.parse(raw) as ActiveJson).versioning;
    if (
      v?.strategy === 'locked-prefix' &&
      typeof v.prefix === 'string' &&
      v.prefix.trim().length > 0
    ) {
      return { strategy: 'locked-prefix', prefix: v.prefix, bump: v.bump ?? 'patch-per-release' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * AGF.1 — read the RAW (possibly PARTIAL) project `versioning` object from a scope's `active.json`, unvalidated,
 * for the pack-default MERGE ({@link resolveVersioning}). Unlike {@link readActiveVersioning} (which returns a
 * fully-validated config or null), this preserves a project that declares only a subset (e.g. just `{prefix}`)
 * so the merge can fill the rest from the pack default. Lenient: absent scope / ENOENT / any parse fault → null.
 */
async function readRawProjectVersioning(
  scopeRoot: string | null,
): Promise<Partial<VersioningConfig> | null> {
  if (scopeRoot === null) return null;
  try {
    const raw = await fs.readFile(join(scopeRoot, 'active.json'), 'utf-8');
    const v = (JSON.parse(raw) as { versioning?: Partial<VersioningConfig> }).versioning;
    return v ?? null;
  } catch {
    return null;
  }
}

/**
 * AGF.1 — the PURE one-directional versioning merge: the PROJECT object OVERRIDES the PACK default field-by-field
 * (SSOT — no third store), then the merged shape is validated. A project that declares only `{prefix:'0.5'}` still
 * resolves `strategy`/`bump` from the pack default; a project that declares nothing inherits the pack default
 * whole; both absent → null. Returns a validated `VersioningConfig` or null when the merged shape is not a
 * well-formed locked-prefix config (no valid `strategy`/`prefix` from either source).
 */
export function mergeVersioning(
  packDefault: Partial<VersioningConfig> | null,
  project: Partial<VersioningConfig> | null,
): VersioningConfig | null {
  if (packDefault === null && project === null) return null;
  const merged = { ...(packDefault ?? {}), ...(project ?? {}) }; // project overrides pack (one-directional)
  if (
    merged.strategy === 'locked-prefix' &&
    typeof merged.prefix === 'string' &&
    merged.prefix.trim().length > 0
  ) {
    return {
      strategy: 'locked-prefix',
      prefix: merged.prefix,
      bump: merged.bump ?? 'patch-per-release',
    };
  }
  return null;
}

/**
 * AGF.1 — RESOLVE the effective versioning config for a scope: the RAW project object (possibly partial) merged
 * OVER the active pack's declared default ({@link mergeVersioning}, project-over-pack). This is the reader the
 * automated git-flow consumes (release.ts) so a project that declares only the `prefix` — or omits `versioning`
 * entirely — still resolves the `strategy`/`bump` from the PACK (design §6: "versioning strategy defaulted in the
 * pack + the prefix in the project active.json"). The pack default is the FIRST active v2 pack that declares a
 * `versioning` block; a pack-load fault never breaks resolution (the project object may already suffice → null
 * pack default). Returns the validated config or null when neither source yields a well-formed locked-prefix shape.
 */
export async function resolveVersioning(
  scopeRoot: string | null,
  builtinRoot: string | null = null,
  userScopeRoot: string | null = null,
): Promise<VersioningConfig | null> {
  const project = await readRawProjectVersioning(scopeRoot);
  let packDefault: Partial<VersioningConfig> | null = null;
  try {
    const { v2 } = await partitionActivePacks(scopeRoot, null, builtinRoot, userScopeRoot);
    packDefault = v2.map((p) => p.pack.versioning).find((v) => v !== undefined) ?? null;
  } catch {
    packDefault = null; // a pack-load fault must never break versioning resolution
  }
  return mergeVersioning(packDefault, project);
}

/**
 * REVERSIBLE-DEPLOY — read the per-project `deploy.reversible` flag from a scope's `active.json` (see
 * {@link ActiveJson.reversible}). Returns `true` ONLY when the flag is explicitly `true`; all other cases
 * (absent, false, unreadable, malformed) return `false` (FAIL-CLOSED: unknown ⇒ irreversible ⇒ human gate).
 * Mirrors {@link readActiveVerifyCommand}.
 */
export async function readActiveDeployReversible(scopeRoot: string | null): Promise<boolean> {
  // GF.8 (scope-8) — a configured git-flow project's DEPLOY stage is reversible BY CONSTRUCTION (the commit+push
  // to a working branch and the merge-to-staging are revertable; only the PR-merge to production is irreversible).
  // So the environments-derived boundary is the SOURCE OF TRUTH; the explicit `reversible` flag is a back-compat
  // fallback ONLY for a project not on the `version-control.environments` block.
  const env = await resolveEnvironments(scopeRoot);
  if (env !== null) return reversibilityBoundaryFor(env);
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
 * GF.8 (scope-8) — the reversibility boundary DERIVED from `version-control.environments` (subsumes the ad-hoc
 * `reversible` flag): a project ON the automated git-flow (`env !== null`) has a reversible DEPLOY stage — the
 * commit+push to a working branch (and the merge-to-staging) are revertable; the SOLE irreversible act is the
 * human PR-merge to production (which triggers the CI publish, GF.7). So has-stage/no-stage is ONE config-derived
 * boundary, not a separate flag consulted ad hoc.
 */
export function reversibilityBoundaryFor(env: ResolvedEnvironments | null): boolean {
  return env !== null;
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

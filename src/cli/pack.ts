/**
 * LP.4 — `opensquid pack` CLI surface: install / list / set / export / remove.
 * PT.1 — `set <name> off|local|global` is the tri-state scope control (writes the
 * user/project `active.json`; effective next tool call, no restart); `list` reports
 * every known pack's configured state.
 *
 * v1 minimum-viable per pragmatic scope:
 *   - install: local directory only (tarball + URL deferred to v1.5)
 *   - list: full
 *   - export: lessons-only + raw (with-evidence deferred to v1.5)
 *   - remove: --yes + --also-personal-revision flags
 *
 * Path-traversal defense via `validatePackId` (LP.3) on every command that
 * accepts a pack name. `personal_revision/` preserved by default on remove
 * (no-delete axiom per [[project_memory_architecture_dual_surface_sync]]).
 *
 * Imports: commander, node:fs/promises, node:os, node:path, yaml,
 *   LP.1 personal_revision + LP.2 versioning + LP.3 discovery helpers.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { resolvePackStateDir, validatePackId } from '../packs/discovery.js';
import {
  resolveBuiltinScopeRoot,
  resolveProjectScopeRoot,
  resolveUserScopeRoot,
} from '../runtime/paths.js';
import {
  buildActiveJson,
  readActivePackNames,
  removeFromActiveJson,
} from '../setup/cli/chat_actions_writers.js';
import { loadPack } from '../packs/loader.js';
import {
  initPersonalRevision,
  readLessonFiles,
  readVersionJson,
  type LessonFile,
} from '../packs/personal_revision.js';
import { Manifest } from '../packs/schemas/manifest.js';
import { validatePackFunctions, type ValidationIssue } from '../packs/validate_functions.js';
import { buildValidationRegistry } from '../runtime/bootstrap.js';
import { runThreeWayMerge } from '../runtime/versioning.js';

export type ExportMode = 'lessons-only' | 'raw';

interface CommonOpts {
  scope?: 'user' | 'project';
  projectCwd?: string;
}

type InstallOpts = CommonOpts;
interface ExportOpts extends CommonOpts {
  mode?: ExportMode;
  out?: string;
}
interface RemoveOpts extends CommonOpts {
  yes?: boolean;
  alsoPersonalRevision?: boolean;
}

export interface PackCliDeps {
  /** Test seam — override stdout for assertion. */
  out?: (line: string) => void;
  /** Test seam — bypass interactive prompt; treat all confirmations as yes. */
  forceYes?: boolean;
}

function emit(deps: PackCliDeps): (line: string) => void {
  return deps.out ?? ((line) => process.stdout.write(line + '\n'));
}

async function readAndValidateManifest(packDir: string): Promise<{
  name: string;
  version: string;
}> {
  const raw = await readFile(join(packDir, 'manifest.yaml'), 'utf8');
  const parsed = parseYaml(raw) as unknown;
  const manifest = Manifest.parse(parsed);
  return { name: manifest.name, version: manifest.version };
}

function semverLt(a: string, b: string): boolean {
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

export function buildInstallCommand(deps: PackCliDeps = {}): Command {
  const print = emit(deps);
  return new Command('install')
    .description('Install a pack from a local directory (tarball + URL deferred to v1.5)')
    .argument('<source>', 'Path to pack directory containing manifest.yaml')
    .option('--scope <scope>', 'user | project', 'user')
    .option('--project-cwd <path>', 'Project root (required for --scope project)')
    .action(async (source: string, opts: InstallOpts) => {
      const manifest = await readAndValidateManifest(source);
      validatePackId(manifest.name);

      // PV.2 (T-wire-pack-validators): block a pack whose rules reference an unregistered primitive —
      // otherwise it installs, loads, and the bad rule SILENTLY fails to enforce at runtime. Validate
      // against the full primitive-name set (no backend I/O via buildValidationRegistry), BEFORE any
      // copy/merge. Fail-OPEN on a VALIDATOR BUG (a thrown error), block only on a GENUINE PACK ISSUE
      // (a clean, non-throwing nonempty `issues[]`) — never break a clean install on our own bug.
      let issues: ValidationIssue[] = [];
      try {
        const sourcePack = await loadPack(source);
        issues = validatePackFunctions(sourcePack, await buildValidationRegistry());
      } catch (e) {
        print(
          `[opensquid pack install] WARN: function-ref validation skipped (${e instanceof Error ? e.message : String(e)}); ` +
            `installing anyway — the pack is re-checked at session start.`,
        );
      }
      if (issues.length > 0) {
        throw new Error(
          `[opensquid pack install] ${manifest.name} references unknown primitives — fix before install:\n` +
            issues
              .map(
                (i) =>
                  `  - ${i.skill}/${i.ruleId} step ${String(i.step)}: "${i.missing}"` +
                  (i.suggestion !== undefined ? ` (did you mean "${i.suggestion}"?)` : ''),
              )
              .join('\n'),
        );
      }

      const stateDir = resolvePackStateDir(manifest.name, opts.scope ?? 'user', opts.projectCwd);
      const existing = await readVersionJson(stateDir);

      if (existing !== null && existing.base_version !== manifest.version) {
        if (semverLt(existing.base_version, manifest.version)) {
          // Upgrade — copy new vanilla to staging + run merge.
          const stagingDir = join(stateDir, 'base-staging');
          await rm(stagingDir, { recursive: true, force: true });
          await cp(source, stagingDir, { recursive: true });
          const mergeResult = await runThreeWayMerge({
            packId: manifest.name,
            baseDir: join(stateDir, 'base'),
            personalStateDir: stateDir,
            vanillaDir: stagingDir,
            vanillaVersion: manifest.version,
          });
          // Promote staging → base after successful merge.
          await rm(join(stateDir, 'base'), { recursive: true, force: true });
          await cp(stagingDir, join(stateDir, 'base'), { recursive: true });
          await rm(stagingDir, { recursive: true, force: true });
          print(
            `[opensquid pack install] Upgraded ${manifest.name} from ${existing.base_version} → ${manifest.version}`,
          );
          print(`  - dispositions: ${String(mergeResult.dispositions.length)}`);
          print(`  - conflicts:    ${String(mergeResult.conflictCount)}`);
          if (mergeResult.conflictCount > 0) {
            print(
              `  Resolve conflicts in ${stateDir}/personal_revision/*.conflict.yaml then rename back to .yaml`,
            );
          }
        } else {
          throw new Error(
            `Downgrade rejected: existing ${existing.base_version} > new ${manifest.version}. v1 does not support --force.`,
          );
        }
      } else {
        await mkdir(stateDir, { recursive: true });
        await cp(source, join(stateDir, 'base'), { recursive: true });
        await initPersonalRevision(stateDir, manifest.version);
        print(
          `[opensquid pack install] Installed ${manifest.name}@${manifest.version} → ${stateDir}`,
        );
      }
    });
}

// PT.1 — tri-state pack control. A pack's CONFIGURED state is exactly one of
// off (in neither active.json), local (project active.json only), or global
// (user active.json only). This reports DECLARED scope — orthogonal to the
// per-session `detected_by[]` gating `discoverActivePacks` also applies (a pack
// configured `global` may still be detection-gated off this session).
export type PackState = 'off' | 'local' | 'global';
type PackOrigin = 'builtin' | 'user' | 'project';
interface PackListRow {
  name: string;
  state: PackState;
  origin: PackOrigin;
}
interface ListOpts {
  projectCwd?: string;
  json?: boolean;
}
interface SetOpts {
  projectCwd?: string;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** Built-in pack names = `packs/builtin/<name>/manifest.yaml` (excludes non-pack
 *  dirs like `examples/`). */
async function listBuiltinPackNames(builtinRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdirSafe(builtinRoot)) {
    try {
      await stat(join(builtinRoot, name, 'manifest.yaml'));
      out.push(name);
    } catch {
      /* not a pack dir */
    }
  }
  return out;
}

/** Installed pack names under a `<scope>/packs/` dir = those carrying a
 *  `version.json` (the install marker, via `readVersionJson`). */
async function listInstalledPackNames(packsDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdirSafe(packsDir)) {
    if ((await readVersionJson(join(packsDir, name)).catch(() => null)) !== null) out.push(name);
  }
  return out;
}

/** A pack is REAL if it is a built-in OR installed at user / project scope. The
 *  existence check guards `set` against writing a dead name into `active.json`
 *  (a name `discoverActivePacks` can't resolve THROWS and bricks every hook). */
async function packExists(name: string, projectRoot: string | null): Promise<boolean> {
  try {
    await stat(join(resolveBuiltinScopeRoot(), name, 'manifest.yaml'));
    return true;
  } catch {
    /* not built-in */
  }
  if ((await readVersionJson(resolvePackStateDir(name, 'user')).catch(() => null)) !== null) {
    return true;
  }
  if (
    projectRoot !== null &&
    (await readVersionJson(join(projectRoot, 'packs', name)).catch(() => null)) !== null
  ) {
    return true;
  }
  return false;
}

/** Add `name` to `<scopeRoot>/active.json` (create the dir/file if absent). */
async function addToActive(scopeRoot: string, name: string): Promise<void> {
  await mkdir(scopeRoot, { recursive: true });
  const existing = await readActivePackNames(scopeRoot);
  await writeFile(join(scopeRoot, 'active.json'), buildActiveJson(existing, name));
}

/** Remove `name` from `<scopeRoot>/active.json`; no-op (no write) when the file
 *  is absent or the name isn't present, so we never create an empty active.json
 *  just to remove. A garbled file throws (readActivePackNames) → abort, no overwrite. */
async function removeFromActive(scopeRoot: string, name: string): Promise<void> {
  const existing = await readActivePackNames(scopeRoot);
  if (!existing.includes(name)) return;
  await writeFile(join(scopeRoot, 'active.json'), removeFromActiveJson(existing, name));
}

export function buildListCommand(deps: PackCliDeps = {}): Command {
  const print = emit(deps);
  return new Command('list')
    .description('List every known pack with its configured state (off | local | global)')
    .option('--project-cwd <path>', 'Project root (default: cwd walk-up)')
    .option('--json', 'Emit machine-readable JSON rows', false)
    .action(async (opts: ListOpts) => {
      const cwd = opts.projectCwd ?? process.cwd();
      const userRoot = resolveUserScopeRoot();
      const projectRoot = await resolveProjectScopeRoot(cwd);

      const builtin = new Set(await listBuiltinPackNames(resolveBuiltinScopeRoot()));
      const userInstalled = new Set(await listInstalledPackNames(join(userRoot, 'packs')));
      const projectInstalled = new Set(
        projectRoot !== null ? await listInstalledPackNames(join(projectRoot, 'packs')) : [],
      );
      const userActive = new Set(await readActivePackNames(userRoot));
      const projectActive = new Set(
        projectRoot !== null ? await readActivePackNames(projectRoot) : [],
      );

      const names = [
        ...new Set([
          ...builtin,
          ...userInstalled,
          ...projectInstalled,
          ...userActive,
          ...projectActive,
        ]),
      ].sort();

      const rows: PackListRow[] = names.map((name) => ({
        name,
        // user-wins precedence — matches the loader's dedupe (global dominates).
        state: userActive.has(name) ? 'global' : projectActive.has(name) ? 'local' : 'off',
        origin: builtin.has(name)
          ? 'builtin'
          : userInstalled.has(name)
            ? 'user'
            : projectInstalled.has(name)
              ? 'project'
              : 'builtin',
      }));

      if (opts.json === true) {
        print(JSON.stringify(rows));
        return;
      }
      if (rows.length === 0) {
        print('[opensquid pack list] No packs found');
        return;
      }
      for (const r of rows) {
        print(`${r.name.padEnd(40)} ${r.state.padEnd(7)} ${r.origin}`);
      }
    });
}

export function buildSetCommand(deps: PackCliDeps = {}): Command {
  const print = emit(deps);
  return new Command('set')
    .description('Set a pack to off | local | global (effective next tool call; no restart)')
    .argument('<name>', 'Pack name')
    .argument('<state>', 'off | local | global')
    .option('--project-cwd <path>', 'Project root (default: cwd walk-up)')
    .action(async (name: string, state: string, opts: SetOpts) => {
      validatePackId(name);
      if (state !== 'off' && state !== 'local' && state !== 'global') {
        throw new Error(`opensquid pack set: state must be off|local|global, got "${state}"`);
      }
      const cwd = opts.projectCwd ?? process.cwd();
      const userRoot = resolveUserScopeRoot();
      // Local = the project Claude was started in (cwd walk-up to an existing
      // `.opensquid/`); create `<cwd>/.opensquid/` when none exists.
      const projectRoot = (await resolveProjectScopeRoot(cwd)) ?? join(cwd, '.opensquid');

      if (!(await packExists(name, projectRoot))) {
        throw new Error(`opensquid pack set: no such pack (installed or built-in): ${name}`);
      }

      // add-before-remove: a crash between the two writes leaves the pack active
      // in both scopes, which the loader's dedupe collapses to a single load —
      // never a window where the pack vanishes from both. Idempotent → re-run converges.
      if (state === 'global') {
        await addToActive(userRoot, name);
        await removeFromActive(projectRoot, name);
      } else if (state === 'local') {
        await addToActive(projectRoot, name);
        await removeFromActive(userRoot, name);
      } else {
        await removeFromActive(userRoot, name);
        await removeFromActive(projectRoot, name);
      }
      print(
        `pack ${name}: ${state} — takes effect on the next tool call (no Claude restart needed)`,
      );
    });
}

function stripLessonsOnly(lessons: readonly LessonFile[]): LessonFile[] {
  return lessons.map((lesson) => {
    const bodyStr = JSON.stringify(lesson.body);
    const stripped = bodyStr.replace(/<cite\s+id=mem-[a-f0-9-]+>([^<]*)<\/cite>/g, '$1');
    const parsedBody = JSON.parse(stripped) as Record<string, unknown>;
    delete parsedBody.cited_memory_ids;
    return { ...lesson, body: parsedBody };
  });
}

export function buildExportCommand(deps: PackCliDeps = {}): Command {
  const print = emit(deps);
  return new Command('export')
    .description('Export a pack with one of 2 stripping modes (with-evidence is v1.5)')
    .argument('<name>', 'Pack name')
    .option('--mode <mode>', 'lessons-only (default) | raw', 'lessons-only')
    .option('--out <path>', 'Output directory path (default <name>-<mode>-export/)')
    .option('--scope <scope>', 'user | project', 'user')
    .option('--project-cwd <path>', 'Project root (required for --scope project)')
    .action(async (name: string, opts: ExportOpts) => {
      validatePackId(name);
      const mode: ExportMode = opts.mode ?? 'lessons-only';
      if (mode !== 'lessons-only' && mode !== 'raw') {
        throw new Error(
          `Invalid --mode: ${String(mode)}. v1 ships: lessons-only | raw. (with-evidence deferred to v1.5)`,
        );
      }
      const stateDir = resolvePackStateDir(name, opts.scope ?? 'user', opts.projectCwd);
      const version = await readVersionJson(stateDir);
      if (version === null) {
        throw new Error(`Pack ${name} is not installed (no version.json at ${stateDir})`);
      }
      const lessons = await readLessonFiles(stateDir);
      const exportedLessons = mode === 'raw' ? lessons : stripLessonsOnly(lessons);
      const outDir = opts.out ?? `${name}-${mode}-export`;
      await mkdir(outDir, { recursive: true });
      // Copy manifest + skills tree from base/
      await cp(join(stateDir, 'base'), join(outDir, 'pack'), { recursive: true }).catch(
        () => undefined,
      );
      // Write lessons + version.json (raw only)
      const lessonsOutDir = join(outDir, 'personal_revision');
      await mkdir(lessonsOutDir, { recursive: true });
      for (const lesson of exportedLessons) {
        const fname = lesson.hasConflict
          ? `lesson_${String(lesson.id)}.conflict.yaml`
          : `lesson_${String(lesson.id)}.yaml`;
        await writeFile(join(lessonsOutDir, fname), stringifyYaml(lesson.body), 'utf8');
      }
      if (mode === 'raw') {
        await writeFile(
          join(lessonsOutDir, 'version.json'),
          JSON.stringify(version, null, 2),
          'utf8',
        );
      }
      print(`[opensquid pack export] Exported ${name} → ${outDir} (mode: ${mode})`);
      print(`  - lessons:  ${String(exportedLessons.length)}`);
    });
}

export function buildRemoveCommand(deps: PackCliDeps = {}): Command {
  const print = emit(deps);
  return new Command('remove')
    .description('Remove an installed pack (preserves personal_revision/ by default)')
    .argument('<name>', 'Pack name')
    .option('--yes', 'Skip confirmation prompt', false)
    .option('--also-personal-revision', 'Also delete personal_revision/ (DESTRUCTIVE)', false)
    .option('--scope <scope>', 'user | project', 'user')
    .option('--project-cwd <path>', 'Project root (required for --scope project)')
    .action(async (name: string, opts: RemoveOpts) => {
      validatePackId(name);
      const stateDir = resolvePackStateDir(name, opts.scope ?? 'user', opts.projectCwd);
      const version = await readVersionJson(stateDir).catch(() => null);
      if (version === null) {
        print(`[opensquid pack remove] Pack ${name} is not installed`);
        return;
      }
      const skipPrompt = opts.yes === true || deps.forceYes === true;
      if (!skipPrompt) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = await rl.question(
          `Remove pack ${name} (revision=${String(version.personal_revision_id)})? [y/N] `,
        );
        rl.close();
        if (ans.trim().toLowerCase() !== 'y') {
          print('Aborted.');
          return;
        }
      }
      await rm(join(stateDir, 'base'), { recursive: true, force: true });
      if (opts.alsoPersonalRevision === true) {
        await rm(join(stateDir, 'personal_revision'), { recursive: true, force: true });
        print(`[opensquid pack remove] Removed ${name} (including personal_revision/)`);
      } else {
        print(
          `[opensquid pack remove] Removed ${name} (preserved personal_revision/ — delete manually if desired)`,
        );
      }
    });
}

export function registerPackCli(program: Command, deps: PackCliDeps = {}): Command {
  const pack = program
    .command('pack')
    .description('Manage opensquid packs (install / list / set / export / remove)');
  pack.addCommand(buildInstallCommand(deps));
  pack.addCommand(buildListCommand(deps));
  pack.addCommand(buildSetCommand(deps));
  pack.addCommand(buildExportCommand(deps));
  pack.addCommand(buildRemoveCommand(deps));
  return pack;
}

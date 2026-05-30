/**
 * LP.4 — `opensquid pack` CLI surface: install / list / export / remove.
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
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { resolvePackStateDir, validatePackId } from '../packs/discovery.js';
import {
  initPersonalRevision,
  readLessonFiles,
  readVersionJson,
  type LessonFile,
} from '../packs/personal_revision.js';
import { Manifest } from '../packs/schemas/manifest.js';
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

export function buildListCommand(deps: PackCliDeps = {}): Command {
  const print = emit(deps);
  return new Command('list')
    .description('List installed packs')
    .option('--scope <scope>', 'user | project', 'user')
    .option('--project-cwd <path>', 'Project root (required for --scope project)')
    .action(async (opts: CommonOpts) => {
      const baseDir =
        opts.scope === 'project'
          ? join(opts.projectCwd ?? process.cwd(), '.opensquid', 'packs')
          : join(process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid'), 'packs');
      let entries: string[];
      try {
        entries = await readdir(baseDir);
      } catch {
        print(`[opensquid pack list] No packs installed in ${baseDir}`);
        return;
      }
      let listed = 0;
      for (const name of entries) {
        const stateDir = join(baseDir, name);
        const version = await readVersionJson(stateDir).catch(() => null);
        if (version === null) continue;
        const lastMerged =
          version.last_merged_vanilla !== null ? ` lastMerged=${version.last_merged_vanilla}` : '';
        print(
          `${name.padEnd(40)} base=${version.base_version} revision=${String(version.personal_revision_id)}${lastMerged}`,
        );
        listed++;
      }
      if (listed === 0) print(`[opensquid pack list] No installed packs in ${baseDir}`);
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
    .description('Manage installed opensquid packs (install / list / export / remove)');
  pack.addCommand(buildInstallCommand(deps));
  pack.addCommand(buildListCommand(deps));
  pack.addCommand(buildExportCommand(deps));
  pack.addCommand(buildRemoveCommand(deps));
  return pack;
}

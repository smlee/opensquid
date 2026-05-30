/**
 * LP.2 — 3-way merge for vanilla pack upgrades.
 *
 * Compares 3 snapshots (base / personal / vanilla) → MergeResult with 4
 * dispositions (unchanged / auto-merged-personal / auto-merged-vanilla /
 * conflict). Emits `lesson_<n>.conflict.yaml` sidecars with YAML-comment-safe
 * git-style markers on overlap. Updates `last_merged_vanilla` on success.
 * Idempotent (same vanilla → noop). Throws on downgrade or missing
 * version.json.
 *
 * Per [[feedback_stop_haiku_drift]] L4: text/YAML compare only; no LLM.
 * Per [[feedback_simplest_granular_form]]: substring-based
 * lessonReferencesSkill heuristic; semantic awareness deferred post-v1.
 *
 * Imports: src/packs/personal_revision.ts (LP.1), node:fs/promises, node:path.
 * Imported by: LP.5 discovery upgrade detector, LP.4 CLI manual trigger.
 */
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  readLessonFiles,
  readVersionJson,
  writeVersionJson,
  type LessonFile,
} from '../packs/personal_revision.js';
import type { BaseVersion } from '../packs/schemas/manifest.js';

export type FileDisposition =
  | { kind: 'unchanged'; path: string }
  | { kind: 'auto-merged-personal'; path: string; reason: 'personal-only-edit' }
  | { kind: 'auto-merged-vanilla'; path: string; reason: 'vanilla-only-edit' }
  | { kind: 'conflict'; path: string; conflictSidecarPath: string };

export interface MergeResult {
  packId: string;
  baseVersion: BaseVersion;
  vanillaVersion: BaseVersion;
  personalRevisionId: number;
  dispositions: FileDisposition[];
  conflictCount: number;
  /** True iff merge completed without errors (conflicts are NOT errors). */
  ok: boolean;
  /** True iff merge was a no-op (already merged against this vanilla). */
  noop: boolean;
}

export interface ThreeWayMergeInput {
  packId: string;
  baseDir: string;
  personalStateDir: string;
  vanillaDir: string;
  vanillaVersion: BaseVersion;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.opensquid', 'personal_revision']);
const EXT_RE = /\.(yaml|yml|md)$/i;

export async function runThreeWayMerge(input: ThreeWayMergeInput): Promise<MergeResult> {
  const current = await readVersionJson(input.personalStateDir);
  if (current === null) {
    throw new Error(`runThreeWayMerge: ${input.packId} has no version.json — install pack first`);
  }
  if (semverCompare(input.vanillaVersion, current.base_version) < 0) {
    throw new Error(
      `runThreeWayMerge: ${input.packId} — vanilla version ${input.vanillaVersion} must be >= base ${current.base_version}`,
    );
  }
  if (current.last_merged_vanilla === input.vanillaVersion) {
    return {
      packId: input.packId,
      baseVersion: current.base_version,
      vanillaVersion: input.vanillaVersion,
      personalRevisionId: current.personal_revision_id,
      dispositions: [],
      conflictCount: 0,
      ok: true,
      noop: true,
    };
  }

  const baseFiles = await readPackTextFiles(input.baseDir);
  const vanillaFiles = await readPackTextFiles(input.vanillaDir);
  const personalLessons = await readLessonFiles(input.personalStateDir);

  const dispositions: FileDisposition[] = [];
  const allSkillPaths = new Set<string>([...Object.keys(baseFiles), ...Object.keys(vanillaFiles)]);

  for (const path of allSkillPaths) {
    const baseContent = baseFiles[path] ?? null;
    const vanillaContent = vanillaFiles[path] ?? null;
    if (baseContent === vanillaContent) {
      dispositions.push({ kind: 'unchanged', path });
      continue;
    }
    const personalTouch = personalLessons.find(
      (l) => !l.hasConflict && lessonReferencesSkill(l, path),
    );
    if (personalTouch === undefined) {
      dispositions.push({
        kind: 'auto-merged-vanilla',
        path,
        reason: 'vanilla-only-edit',
      });
      continue;
    }
    const conflictSidecar = await emitConflictSidecar(
      personalTouch,
      baseContent ?? '',
      vanillaContent ?? '',
      input.vanillaVersion,
    );
    dispositions.push({
      kind: 'conflict',
      path,
      conflictSidecarPath: conflictSidecar,
    });
  }

  // Personal-only lessons (touch files vanilla didn't change) → preserve.
  for (const lesson of personalLessons) {
    if (lesson.hasConflict) continue;
    const alreadyDisposed = dispositions.some(
      (d) =>
        d.kind === 'conflict' && d.conflictSidecarPath.includes(`lesson_${String(lesson.id)}.`),
    );
    if (alreadyDisposed) continue;
    dispositions.push({
      kind: 'auto-merged-personal',
      path: lesson.path,
      reason: 'personal-only-edit',
    });
  }

  await writeVersionJson(input.personalStateDir, {
    ...current,
    last_merged_vanilla: input.vanillaVersion,
  });

  return {
    packId: input.packId,
    baseVersion: current.base_version,
    vanillaVersion: input.vanillaVersion,
    personalRevisionId: current.personal_revision_id,
    dispositions,
    conflictCount: dispositions.filter((d) => d.kind === 'conflict').length,
    ok: true,
    noop: false,
  };
}

/**
 * Recursively read all .yaml/.yml/.md text files in a pack directory into a
 * map of (relative-path → file content). Skips node_modules/.git/.opensquid/
 * personal_revision. Returns empty map if dir is missing. Path-traversal
 * defense: relative() output starting with '..' is rejected.
 */
async function readPackTextFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await walk(dir, dir, out);
  return out;
}

async function walk(root: string, current: string, out: Record<string, string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(current);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(current, name);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    if (!EXT_RE.test(name)) continue;
    const rel = relative(root, full);
    if (rel.startsWith('..')) continue;
    out[rel] = await readFile(full, 'utf8');
  }
}

function lessonReferencesSkill(lesson: LessonFile, skillPath: string): boolean {
  const skillField = lesson.body.skill;
  if (typeof skillField === 'string' && skillField === skillPath) return true;
  return JSON.stringify(lesson.body).includes(skillPath);
}

async function emitConflictSidecar(
  lesson: LessonFile,
  baseContent: string,
  vanillaContent: string,
  vanillaVersion: BaseVersion,
): Promise<string> {
  const sidecarPath = lesson.path.replace(/\.yaml$/, '.conflict.yaml');
  const baseLines = baseContent.split('\n').map((l) => `# ${l}`);
  const vanillaLines = vanillaContent.split('\n').map((l) => `# ${l}`);
  const header = [
    '# CONFLICT: vanilla bump overlaps with personal_revision edit.',
    '# Resolve by removing marker lines + keeping desired content,',
    '# then rename this file back to lesson_<n>.yaml.',
    '#',
    '# <<<<<<< base',
    ...baseLines,
    '# =======',
    ...vanillaLines,
    `# >>>>>>> vanilla ${vanillaVersion}`,
    '',
  ].join('\n');
  const originalBody = await readFile(lesson.path, 'utf8');
  await mkdir(join(sidecarPath, '..'), { recursive: true }).catch(() => undefined);
  const tmp = `${sidecarPath}.tmp.${String(process.pid)}.${randSuffix()}`;
  await writeFile(tmp, header + originalBody, 'utf8');
  await rename(tmp, sidecarPath);
  return sidecarPath;
}

/** Naive semver comparator — sufficient for v1 (BaseVersion regex constrains shape). */
function semverCompare(a: BaseVersion, b: BaseVersion): number {
  const parsePart = (s: string): number[] =>
    s
      .split('-')[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const av = parsePart(a);
  const bv = parsePart(b);
  for (let i = 0; i < 3; i++) {
    const d = (av[i] ?? 0) - (bv[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function randSuffix(): string {
  const t = process.hrtime.bigint();
  return (t & 0xffffffffn).toString(16).padStart(8, '0');
}

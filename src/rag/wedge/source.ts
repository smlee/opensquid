/**
 * Per-file source-of-truth for wedge-gate lessons (retire-Rust RES-3b). Mirrors
 * `src/rag/backends/perfile_source.ts` but with the wedge field set and a STATUS-DIR layout:
 * each lesson is `<sourceDir>/<status>/<id>.md` — the same on-disk shape the Rust engine uses
 * (`~/.opensquid/lessons/<status>/les-*.md`), so RES-3d migrates the existing 49 lessons by
 * re-indexing them. The per-file form is the git-versionable truth; the libSQL `wg_lessons` table
 * is the derived, rebuildable index. A status transition is a FILE MOVE between status dirs:
 * `writeWedgeRecord` writes the NEW status file, then the caller `deleteWedgeRecord`s the old one.
 *
 * Imports from: node:fs/promises, node:path, yaml, ../../storage/atomic_file.js.
 * Imported by: src/rag/wedge/store.ts.
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { atomicWriteFile, safeRecordId } from '../../storage/atomic_file.js';

import type { CausalNarrative, LessonStatus } from './gate.js';
import type { WedgeLesson } from './store.js';

/** gate.rs MAX_APPLIED_SESSION_IDS — cap applied_session_ids growth. */
export const MAX_APPLIED_SESSION_IDS = 50;

const STATUS_DIRS: LessonStatus[] = ['pending', 'active', 'promoted', 'superseded', 'discarded'];

/** Write `<sourceDir>/<status>/<id>.md` atomically (dir DERIVED from `lesson.status`). */
export async function writeWedgeRecord(sourceDir: string, lesson: WedgeLesson): Promise<void> {
  const frontmatter = stringifyYaml({
    id: lesson.id,
    description: lesson.description,
    status: lesson.status,
    authored_by: lesson.authoredBy,
    ...(lesson.packId !== undefined ? { pack_id: lesson.packId } : {}),
    ...(lesson.externalId !== undefined ? { external_id: lesson.externalId } : {}),
    created_at: lesson.createdAt,
    updated_at: lesson.updatedAt,
    ...(lesson.promotedAt !== undefined ? { promoted_at: lesson.promotedAt } : {}),
    ...(lesson.supersededAt !== undefined ? { superseded_at: lesson.supersededAt } : {}),
    ...(lesson.lastAppliedAt !== undefined ? { last_applied_at: lesson.lastAppliedAt } : {}),
    applied_count: lesson.appliedCount,
    thumbs_up_count: lesson.thumbsUpCount,
    thumbs_down_count: lesson.thumbsDownCount,
    external_signal_sources: lesson.externalSignalSources,
    applied_session_ids: lesson.appliedSessionIds,
    ...(lesson.causalNarrative !== undefined ? { causal_narrative: lesson.causalNarrative } : {}),
  });
  await atomicWriteFile(
    join(sourceDir, lesson.status, `${safeRecordId(lesson.id)}.md`),
    `---\n${frontmatter}---\n${lesson.body}`,
  );
}

/** Remove `<sourceDir>/<status>/<id>.md` (the OLD status file on a move). Idempotent. */
export async function deleteWedgeRecord(
  sourceDir: string,
  status: LessonStatus,
  id: string,
): Promise<void> {
  await rm(join(sourceDir, status, `${safeRecordId(id)}.md`), { force: true });
}

/** Read every `<sourceDir>/<status>/*.md` back into `WedgeLesson[]` (RES-3d rebuild). */
export async function readWedgeRecords(sourceDir: string): Promise<WedgeLesson[]> {
  const out: WedgeLesson[] = [];
  for (const status of STATUS_DIRS) {
    const dir = join(sourceDir, status);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    } catch {
      continue; // status dir absent
    }
    for (const f of files) {
      const raw = await readFile(join(dir, f), 'utf8');
      if (!raw.startsWith('---\n')) continue;
      const end = raw.indexOf('\n---\n', 4);
      if (end === -1) continue;
      try {
        const fm = parseYaml(raw.slice(4, end + 1)) as Record<string, unknown>;
        if (typeof fm.id !== 'string') continue;
        out.push({
          id: fm.id,
          description: typeof fm.description === 'string' ? fm.description : '',
          body: raw.slice(end + 5),
          status: (typeof fm.status === 'string' ? fm.status : status) as LessonStatus,
          authoredBy:
            fm.authored_by === 'user' || fm.authored_by === 'pack' ? fm.authored_by : 'agent',
          ...(typeof fm.pack_id === 'string' ? { packId: fm.pack_id } : {}),
          ...(typeof fm.external_id === 'string' ? { externalId: fm.external_id } : {}),
          createdAt: typeof fm.created_at === 'string' ? fm.created_at : new Date(0).toISOString(),
          updatedAt:
            typeof fm.updated_at === 'string'
              ? fm.updated_at
              : typeof fm.created_at === 'string'
                ? fm.created_at
                : new Date(0).toISOString(),
          ...(typeof fm.promoted_at === 'string' ? { promotedAt: fm.promoted_at } : {}),
          ...(typeof fm.superseded_at === 'string' ? { supersededAt: fm.superseded_at } : {}),
          ...(typeof fm.last_applied_at === 'string' ? { lastAppliedAt: fm.last_applied_at } : {}),
          appliedCount: typeof fm.applied_count === 'number' ? fm.applied_count : 0,
          thumbsUpCount: typeof fm.thumbs_up_count === 'number' ? fm.thumbs_up_count : 0,
          thumbsDownCount: typeof fm.thumbs_down_count === 'number' ? fm.thumbs_down_count : 0,
          externalSignalSources: Array.isArray(fm.external_signal_sources)
            ? (fm.external_signal_sources as string[])
            : [],
          appliedSessionIds: Array.isArray(fm.applied_session_ids)
            ? (fm.applied_session_ids as string[])
            : [],
          ...(fm.causal_narrative !== undefined && fm.causal_narrative !== null
            ? { causalNarrative: fm.causal_narrative as CausalNarrative }
            : {}),
        });
      } catch {
        // skip a malformed record; one bad file must not blind the rebuild
      }
    }
  }
  return out;
}

/**
 * Per-file source-of-truth for the libSQL store (T-STORE-PERFILE-SOURCE, rewrite Phase 1 slice
 * 1b). Each lesson is one `---`-fenced YAML-frontmatter + markdown-body file `<dir>/<id>.md` —
 * the same SHAPE as the engine's `mem-*.md` (different field set: lessons carry tags/source/
 * author). This per-file form is the git-versionable, mergeable truth (spike E3: per-file +
 * atomic-claim = 0% git-merge conflict); the libSQL DB is a derived, rebuildable index.
 *
 * `writeRecord` writes ATOMICALLY (temp file + `rename`, atomic on POSIX) so a crash mid-write
 * never leaves a partial/corrupt source file — which is what makes "file-first, DB derived"
 * actually durable. `readRecords` parses the fenced form back to `Lesson` (the body is taken
 * verbatim after the closing fence, so body content containing `---`/`:` never re-enters YAML).
 *
 * Imports from: node:fs/promises, node:path, yaml, ../types.js.
 * Imported by: src/rag/backends/libsql_store.ts.
 */
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { atomicWriteFile, safeRecordId } from '../../storage/atomic_file.js';

import type { Lesson } from '../types.js';

/** Write `<dir>/<id>.md` atomically as `---`-fenced frontmatter + body. */
export async function writeRecord(dir: string, lesson: Lesson): Promise<void> {
  const frontmatter = stringifyYaml({
    id: lesson.id,
    tags: lesson.tags,
    source: lesson.source,
    author: lesson.author,
    created_at: lesson.createdAt,
    // Compression columns serialized ONLY when non-default, so regular-memory files stay
    // byte-identical (no churn / no migration); only consolidated memories gain the keys.
    ...(lesson.derivedFrom?.length ? { derived_from: lesson.derivedFrom } : {}),
    ...(lesson.consumedByUserLessons
      ? { consumed_by_user_lessons: lesson.consumedByUserLessons }
      : {}),
    // Retention (wg-9e4f4eb2a40f): non-default-only, so a rebuild preserves the demoted state.
    ...(lesson.retired_at ? { retired_at: lesson.retired_at } : {}),
    // Durability (wg-4f91e0b5cb8c): serialize only the non-default `point_in_time` (durable = absent),
    // so base-memory files stay byte-identical (no churn / no migration).
    ...(lesson.durability === 'point_in_time' ? { durability: lesson.durability } : {}),
  });
  await atomicWriteFile(
    join(dir, `${safeRecordId(lesson.id)}.md`),
    `---\n${frontmatter}---\n${lesson.content}`,
  );
}

/** Remove `<dir>/<id>.md` (explicit deletion). Idempotent — a missing file is not an error. */
export async function deleteRecord(dir: string, id: string): Promise<void> {
  await rm(join(dir, `${safeRecordId(id)}.md`), { force: true });
}

/** Read every `<dir>/*.md` record back into `Lesson[]`. Missing dir → `[]`. */
export async function readRecords(dir: string): Promise<Lesson[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch {
    return []; // no source dir yet
  }
  const out: Lesson[] = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), 'utf8');
    if (!raw.startsWith('---\n')) continue;
    const end = raw.indexOf('\n---\n', 4);
    if (end === -1) continue;
    const fm = parseYaml(raw.slice(4, end + 1)) as Partial<{
      id: string;
      tags: string[];
      source: string;
      author: string;
      created_at: string;
      derived_from: string[];
      consumed_by_user_lessons: number;
      retired_at: string;
      durability: string;
    }>;
    out.push({
      id: fm.id ?? f.replace(/\.md$/, ''),
      content: raw.slice(end + 5), // everything after the closing "\n---\n"
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      source: fm.source ?? 'memory',
      author: fm.author === 'user' ? 'user' : 'agent',
      createdAt: fm.created_at ?? new Date(0).toISOString(),
      // Compression keys included ONLY when present (mirrors writeRecord's non-default-only write),
      // so a base-memory file round-trips to an object with no compression keys.
      ...(Array.isArray(fm.derived_from) && fm.derived_from.length
        ? { derivedFrom: fm.derived_from }
        : {}),
      ...(typeof fm.consumed_by_user_lessons === 'number' && fm.consumed_by_user_lessons
        ? { consumedByUserLessons: fm.consumed_by_user_lessons }
        : {}),
      ...(typeof fm.retired_at === 'string' && fm.retired_at ? { retired_at: fm.retired_at } : {}),
      ...(fm.durability === 'durable' || fm.durability === 'point_in_time'
        ? { durability: fm.durability }
        : {}),
    });
  }
  return out;
}

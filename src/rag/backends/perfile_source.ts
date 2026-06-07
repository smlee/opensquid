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
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { Lesson } from '../types.js';

/** Reject ids that could escape `dir` — record ids are content hashes, never paths. */
function safeId(id: string): string {
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`perfile_source: unsafe record id: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Write `<dir>/<id>.md` atomically as `---`-fenced frontmatter + body. */
export async function writeRecord(dir: string, lesson: Lesson): Promise<void> {
  await mkdir(dir, { recursive: true });
  const frontmatter = stringifyYaml({
    id: lesson.id,
    tags: lesson.tags,
    source: lesson.source,
    author: lesson.author,
    created_at: lesson.createdAt,
  });
  const path = join(dir, `${safeId(lesson.id)}.md`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `---\n${frontmatter}---\n${lesson.content}`, 'utf8');
  await rename(tmp, path); // atomic on POSIX → readers never see a partial file
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
    }>;
    out.push({
      id: fm.id ?? f.replace(/\.md$/, ''),
      content: raw.slice(end + 5), // everything after the closing "\n---\n"
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      source: fm.source ?? 'memory',
      author: fm.author === 'user' ? 'user' : 'agent',
      createdAt: fm.created_at ?? new Date(0).toISOString(),
    });
  }
  return out;
}

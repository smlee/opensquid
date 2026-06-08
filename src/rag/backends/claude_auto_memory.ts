/**
 * claude-auto-memory RAG backend: wraps Claude Code's own auto-memory
 * directory (`~/.claude/projects/<slug>/memory/`) as a `RagBackend`.
 *
 * This is the strategic adapter — opensquid sits on TOP of Claude Code's
 * auto-memory storage rather than competing with it. Users who already
 * rely on Claude's per-project memory get opensquid's runtime + workflow
 * + wedge gate without migrating data. `embed()` is a no-op because the
 * adapter does not own the embedding pipeline (Claude Code's own
 * vectorizer, if any, is opaque); `recall()` is naive substring search
 * over the directory's `.md` files for Phase 1. Phase 2+ may upgrade to
 * semantic recall if Anthropic exposes the auto-memory vectorizer.
 *
 * `MEMORY.md` is treated as an index (Claude Code maintains it) and
 * excluded from recall hits — including it would surface index-summary
 * matches as if they were lessons.
 *
 * Path containment is enforced on `storeLesson`: a `lesson.id` containing
 * `..` segments must NOT escape the resolved memory dir. We resolve the
 * target file, take its `relative` path from the resolved dir, and reject
 * any result that starts with `..` (or contains a `..` segment). This is
 * the only write surface the adapter exposes, so this check is the only
 * traversal gate needed.
 *
 * `CLAUDE_PROJECT_DIR` is required at init — there is no sensible default.
 * Cross-project leak (resolving to another project's memory) is prevented
 * by failing loudly when the env var is unset, rather than guessing.
 *
 * Imports from: node:fs/promises, node:os, node:path, ../types.js.
 * Imported by: src/rag/backend_factory.ts.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { UserAuthoredImmunityError } from '../types.js';

import type { DeleteResult, Lesson, RagBackend, RecallHit } from '../types.js';

/**
 * Resolve the Claude Code auto-memory dir for the current project.
 *
 * Slug convention (matches Claude Code's own scheme observed at
 * `~/.claude/projects/`): replace every `/` in the absolute project path
 * with `-`. e.g. `/Users/slee/projects/loop` → `-Users-slee-projects-loop`.
 *
 * Throws if `CLAUDE_PROJECT_DIR` is unset — better to fail at init than
 * silently write into a wrong-project memory dir or the current shell's
 * cwd.
 */
export function projectMemoryDir(): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (projectDir === undefined || projectDir === '') {
    throw new Error('claude_auto_memory requires CLAUDE_PROJECT_DIR');
  }
  const slug = projectDir.replaceAll('/', '-');
  // Namespace import (not named) so tests can `vi.spyOn(os, 'homedir')`
  // and have the override take effect — a named import binds the
  // function value at module load time and ignores later mutations.
  return join(os.homedir(), '.claude', 'projects', slug, 'memory');
}

/**
 * Assert that `file` resolves to a path inside `dir`. Defends against
 * `lesson.id` values like `../../../etc/passwd` that would otherwise
 * cause `storeLesson` to write outside the resolved memory dir.
 *
 * `resolve()` collapses `..` segments; `relative()` then tells us
 * whether the result climbed out (`..` prefix) or stayed inside.
 */
function assertInDir(file: string, dir: string): void {
  const resolvedDir = resolve(dir);
  const resolvedFile = resolve(file);
  const rel = relative(resolvedDir, resolvedFile);
  if (rel === '' || rel.startsWith('..') || rel.split(/[\\/]/).includes('..')) {
    throw new Error(`claude_auto_memory: path traversal blocked: ${file}`);
  }
}

export function claudeAutoMemoryBackend(): RagBackend {
  let dir = '';

  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async init() {
      // Resolve only; do not create. Claude Code creates the directory
      // on its first auto-memory write. If we created it eagerly we'd
      // litter `~/.claude/projects/` with empty dirs for any path the
      // user happens to invoke opensquid from.
      dir = projectMemoryDir();
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async embed() {
      return null;
    },

    async recall(query, k): Promise<RecallHit[]> {
      // ENOENT → no memory yet for this project. Return [] rather than
      // throwing so a fresh project doesn't blow up on first recall.
      const files = await readdir(dir).catch((): string[] => []);
      const mds = files.filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      const lowered = query.toLowerCase();
      const hits: RecallHit[] = [];
      for (const f of mds) {
        const content = await readFile(join(dir, f), 'utf8');
        if (content.toLowerCase().includes(lowered)) {
          hits.push({
            lesson: {
              id: basename(f, '.md'),
              content,
              tags: [],
              source: f,
              author: 'user',
              createdAt: '',
            },
            score: 1,
            source: 'lexical',
          });
        }
        if (hits.length >= k) break;
      }
      return hits;
    },

    async storeLesson(lesson: Lesson) {
      await mkdir(dir, { recursive: true });
      const target = join(dir, `${lesson.id}.md`);
      // Reject any `lesson.id` that escapes the resolved memory dir.
      assertInDir(target, dir);
      const frontmatter = [
        `---`,
        `id: ${lesson.id}`,
        `source: ${lesson.source}`,
        `author: ${lesson.author}`,
        `createdAt: ${lesson.createdAt}`,
        `tags: [${lesson.tags.join(', ')}]`,
        `---`,
        ``,
        lesson.content,
      ].join('\n');
      await writeFile(target, frontmatter, 'utf8');
    },

    async deleteLesson(id: string, delOpts?: { force?: boolean }): Promise<DeleteResult> {
      const target = join(dir, `${id}.md`);
      assertInDir(target, dir); // reject a lesson.id escaping the resolved memory dir
      const exists = await readFile(target, 'utf8').then(
        () => true,
        () => false,
      );
      if (!exists) return { deleted: false, forced: false };
      // Claude auto-memories are user-authored → eviction-immune; explicit force required.
      if (!(delOpts?.force ?? false)) throw new UserAuthoredImmunityError(id);
      await rm(target, { force: true });
      return { deleted: true, forced: true };
    },
  };
}

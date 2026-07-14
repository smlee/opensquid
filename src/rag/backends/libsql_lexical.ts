/**
 * Fallback RAG backend: libsql + FTS5 only, no embedding.
 *
 * Used when Ollama is unavailable (no model pulled, network down, user opted
 * out). `embed()` always returns `null`, `recall()` is keyword-only via
 * SQLite FTS5 with the `unicode61` tokenizer. The same `lessons` /
 * `lessons_fts` schema as `libsql-qwen3` so the two backends can share a
 * dbUrl when the fallback wrapper swaps mid-session (Task 1.11) — the
 * vector column on the qwen3 schema is simply ignored here.
 *
 * Self-contained FTS5 (not `content='lessons'` external-content) for the
 * same reason as `libsql_qwen3.ts`: external-content needs mirroring
 * triggers we don't have. We pay O(N) duplicate text storage to keep the
 * write path a flat two-statement INSERT.
 *
 * FTS5 input sanitization here is the simple strip — drop `"` and `*` and
 * trim, then pass the rest verbatim. That gives the user normal phrase
 * search ("foo bar" matches docs containing both, in order) while
 * preventing the two FTS5 syntax tokens that most easily produce
 * `SqliteError: fts5: syntax error`. The qwen3 backend uses a stricter
 * tokens-OR'd scheme because hybrid recall lives or dies on the lexical
 * leg not raising; here the user asked for lexical-only, so we honor more
 * of their query intent (preserving casing, stopwords, ordering hints).
 *
 * Imports from: @libsql/client, ../types.js.
 * Imported by: src/rag/backend_factory.ts.
 */

import { type Client, type Row, createClient } from '@libsql/client';

import { inScope, UserAuthoredImmunityError } from '../types.js';
import { applyConcurrencyPragmas } from '../../storage/sqlite_concurrency.js';

import type { DeleteResult, Lesson, MemoryTier, RagBackend } from '../types.js';

export interface LibsqlLexicalOpts {
  dbUrl: string;
}

export function libsqlLexicalBackend(opts: LibsqlLexicalOpts): RagBackend {
  let client: Client | null = null;

  return {
    async init() {
      client = createClient({ url: opts.dbUrl });
      void applyConcurrencyPragmas(client); // WAL + busy_timeout posture (fire-and-forget; helper never throws)
      // CREATE TABLE IF NOT EXISTS makes this safe to call on a db that
      // libsql-qwen3 already initialized — the existing `embedding` column
      // is just unused here, never read, never written.
      await client.execute(`
        CREATE TABLE IF NOT EXISTS lessons (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          tags TEXT NOT NULL,
          source TEXT NOT NULL,
          author TEXT NOT NULL,
          created_at TEXT NOT NULL,
          tier TEXT NOT NULL DEFAULT 'shared',
          namespace TEXT,
          retired_at TEXT
        );
      `);
      // Additive scope columns for a pre-existing (qwen3-initialized) table. Idempotent.
      for (const ddl of [
        `ALTER TABLE lessons ADD COLUMN tier TEXT NOT NULL DEFAULT 'shared'`,
        `ALTER TABLE lessons ADD COLUMN namespace TEXT`,
        `ALTER TABLE lessons ADD COLUMN retired_at TEXT`,
      ]) {
        try {
          await client.execute(ddl);
        } catch {
          /* already migrated */
        }
      }
      await client.execute(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts
        USING fts5(id UNINDEXED, content, tags, source, tokenize='unicode61');
      `);
      // RSW.1 (wg-9e4f4eb2a40f): partial index so the retention sweep scans only the retired subset.
      await client.execute(
        `CREATE INDEX IF NOT EXISTS idx_lessons_retired ON lessons (retired_at) WHERE retired_at IS NOT NULL`,
      );
    },

    // Deterministic ownership: never leave the native libSQL handle to the N-API finalizer.
    close() {
      const owned = client;
      client = null;
      owned?.close();
      return Promise.resolve();
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async embed() {
      return null;
    },

    async recall(query, k, scope) {
      if (!client) throw new Error('libsql-lexical: not initialized');
      const safe = sanitizeFts(query);
      if (!safe) return [];
      try {
        const rs = await client.execute({
          sql: `SELECT l.id, l.content, l.tags, l.source, l.author, l.created_at, l.tier, l.namespace, l.retired_at
                FROM lessons_fts f JOIN lessons l ON l.id = f.id
                WHERE lessons_fts MATCH ? AND (l.tier = 'shared' OR l.namespace = ?) AND l.retired_at IS NULL
                LIMIT ?`,
          args: [safe, scope.namespace, k],
        });
        return rs.rows
          .map((r, i) => ({
            lesson: rowToLesson(r),
            score: 1 / (i + 1),
            source: 'lexical' as const,
          }))
          .filter((h) => inScope(h.lesson.tier, h.lesson.namespace, scope));
      } catch {
        // Malformed FTS5 expression (rare, since we sanitize) — return [].
        return [];
      }
    },

    async storeLesson(lesson) {
      if (!client) throw new Error('libsql-lexical: not initialized');
      const tagsJson = JSON.stringify(lesson.tags);
      await client.execute({
        sql: `INSERT INTO lessons (id, content, tags, source, author, created_at, tier, namespace, retired_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          lesson.id,
          lesson.content,
          tagsJson,
          lesson.source,
          lesson.author,
          lesson.createdAt,
          (lesson.tier ?? 'shared') satisfies MemoryTier,
          lesson.namespace ?? null,
          lesson.retired_at ?? null,
        ],
      });
      // Mirror into FTS5 — separate statement, not a trigger, to stay
      // portable across libsql builds (same rationale as libsql-qwen3).
      await client.execute({
        sql: `INSERT INTO lessons_fts (id, content, tags, source) VALUES (?, ?, ?, ?)`,
        args: [lesson.id, lesson.content, tagsJson, lesson.source],
      });
    },

    async deleteLesson(id: string, delOpts?: { force?: boolean }): Promise<DeleteResult> {
      if (!client) throw new Error('libsql-lexical: not initialized');
      const found = await client.execute({
        sql: `SELECT author FROM lessons WHERE id = ?`,
        args: [id],
      });
      if (found.rows.length === 0) return { deleted: false, forced: false };
      const isUser = found.rows[0]?.author === 'user';
      const force = delOpts?.force ?? false;
      if (isUser && !force) throw new UserAuthoredImmunityError(id);
      await client.execute({ sql: `DELETE FROM lessons WHERE id = ?`, args: [id] });
      await client.execute({ sql: `DELETE FROM lessons_fts WHERE id = ?`, args: [id] });
      return { deleted: true, forced: isUser && force };
    },

    // wg-9e4f4eb2a40f: demote (retire) — DB-only here (this backend has no per-file source, so no
    // rebuild concern). Leaves the row in `lessons`/`lessons_fts` (rollback floor), out of recall.
    async demoteLesson(id: string): Promise<void> {
      if (!client) throw new Error('libsql-lexical: not initialized');
      await client.execute({
        sql: `UPDATE lessons SET retired_at = ? WHERE id = ?`,
        args: [new Date().toISOString(), id],
      });
    },

    // RSW.1: hard-delete retired AGENT rows past the cutoff via deleteLesson(force). No consumed
    // column on this backend, so author!='user' is the sole (sufficient) immunity floor. DB-only.
    async sweepRetired(cutoffIso: string): Promise<string[]> {
      if (!client) throw new Error('libsql-lexical: not initialized');
      const rs = await client.execute({
        sql: `SELECT id FROM lessons
              WHERE retired_at IS NOT NULL AND retired_at < ? AND author != 'user'`,
        args: [cutoffIso],
      });
      const ids = rs.rows.map((r) => s(r, 'id'));
      for (const id of ids) await this.deleteLesson(id, { force: true });
      return ids;
    },

    // RSW.1: restore any already-demoted USER memory to recall. DB-only UPDATE (no per-file source).
    async repromoteRetiredUserMemories(): Promise<string[]> {
      if (!client) throw new Error('libsql-lexical: not initialized');
      const rs = await client.execute({
        sql: `SELECT id FROM lessons WHERE author = 'user' AND retired_at IS NOT NULL`,
        args: [],
      });
      const ids = rs.rows.map((r) => s(r, 'id'));
      if (ids.length > 0)
        await client.execute({
          sql: `UPDATE lessons SET retired_at = NULL WHERE author = 'user' AND retired_at IS NOT NULL`,
          args: [],
        });
      return ids;
    },
  };
}

// Strip the two FTS5 syntax tokens most likely to be in casual queries.
// Anything left is parsed by FTS5 as a phrase / column-filter / operator
// expression — that is the contract the user gets for lexical-only mode.
function sanitizeFts(query: string): string {
  return query.replace(/["*]/g, ' ').trim();
}

function s(r: Row, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v : '';
}
function rowToLesson(r: Row): Lesson {
  return {
    id: s(r, 'id'),
    content: s(r, 'content'),
    tags: JSON.parse(s(r, 'tags') || '[]') as string[],
    source: s(r, 'source'),
    author: s(r, 'author') === 'user' ? 'user' : 'agent',
    createdAt: s(r, 'created_at'),
    tier: s(r, 'tier') === 'project' ? 'project' : 'shared',
    namespace: typeof r.namespace === 'string' ? r.namespace : null,
    ...(typeof r.retired_at === 'string' && r.retired_at !== ''
      ? { retired_at: r.retired_at }
      : {}),
  };
}

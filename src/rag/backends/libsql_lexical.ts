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

import { UserAuthoredImmunityError } from '../types.js';

import type { DeleteResult, Lesson, RagBackend } from '../types.js';

export interface LibsqlLexicalOpts {
  dbUrl: string;
}

export function libsqlLexicalBackend(opts: LibsqlLexicalOpts): RagBackend {
  let client: Client | null = null;

  return {
    async init() {
      client = createClient({ url: opts.dbUrl });
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
          created_at TEXT NOT NULL
        );
      `);
      await client.execute(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts
        USING fts5(id UNINDEXED, content, tags, source, tokenize='unicode61');
      `);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async embed() {
      return null;
    },

    async recall(query, k) {
      if (!client) throw new Error('libsql-lexical: not initialized');
      const safe = sanitizeFts(query);
      if (!safe) return [];
      try {
        const rs = await client.execute({
          sql: `SELECT l.id, l.content, l.tags, l.source, l.author, l.created_at
                FROM lessons_fts f JOIN lessons l ON l.id = f.id
                WHERE lessons_fts MATCH ?
                LIMIT ?`,
          args: [safe, k],
        });
        return rs.rows.map((r, i) => ({
          lesson: rowToLesson(r),
          score: 1 / (i + 1),
          source: 'lexical' as const,
        }));
      } catch {
        // Malformed FTS5 expression (rare, since we sanitize) — return [].
        return [];
      }
    },

    async storeLesson(lesson) {
      if (!client) throw new Error('libsql-lexical: not initialized');
      const tagsJson = JSON.stringify(lesson.tags);
      await client.execute({
        sql: `INSERT INTO lessons (id, content, tags, source, author, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [lesson.id, lesson.content, tagsJson, lesson.source, lesson.author, lesson.createdAt],
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
  };
}

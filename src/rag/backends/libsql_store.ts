/**
 * Generalized libSQL RAG backend: libsql storage + an INJECTED `Embedder` (hybrid semantic +
 * lexical via RRF). The body is the former `libsql_qwen3` backend with the embedder extracted
 * (T-STORE-FOUNDATION-LIBSQL): `libsql-qwen3` now wires the Ollama-Qwen3 embedder into this,
 * `libsql-fastembed` wires the in-process fastembed embedder. One backend body, any embedder.
 *
 * Schema (libsql vector ext, @libsql/client 0.14): `F32_BLOB(dim)` stores 32-bit float vectors
 * (`dim` from `embedder.dim`); `vector32('[...]')` parses a JSON array; `vector_distance_cos`
 * returns `1 - cosine_similarity`; `libsql_vector_idx(col)` builds the DiskANN ANN index.
 *
 * Imports from: @libsql/client, ../rrf.js, ../embedders/types.js, ../types.js.
 * Imported by: src/rag/backend_factory.ts.
 */
import { type Client, type Row, createClient } from '@libsql/client';

import { rrfFuse } from '../rrf.js';

import { deleteRecord, readRecords, writeRecord } from './perfile_source.js';

import { inScope, UserAuthoredImmunityError } from '../types.js';

import type { Embedder } from '../embedders/types.js';
import type { DeleteResult, Lesson, MemoryTier, RagBackend, RecallHit } from '../types.js';

export interface LibsqlStoreOpts {
  dbUrl: string;
  embedder: Embedder;
  /**
   * Optional per-file source-of-truth dir (T-STORE-PERFILE-SOURCE). When set, `storeLesson`
   * writes `<sourceDir>/<id>.md` (the git-versionable truth) before upserting the DB index, and
   * `rebuildLibsqlIndex` can reconstruct the index from it. When unset, the backend is DB-only
   * (unchanged behavior — e.g. `:memory:` + the `libsql-qwen3` path).
   */
  sourceDir?: string;
}

export function libsqlStoreBackend(opts: LibsqlStoreOpts): RagBackend {
  let client: Client | null = null;
  const { embedder } = opts;

  return {
    async init() {
      client = createClient({ url: opts.dbUrl });
      await client.execute(`
        CREATE TABLE IF NOT EXISTS lessons (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          tags TEXT NOT NULL,
          source TEXT NOT NULL,
          author TEXT NOT NULL,
          created_at TEXT NOT NULL,
          derived_from TEXT NOT NULL DEFAULT '[]',
          consumed_by_user_lessons INTEGER NOT NULL DEFAULT 0,
          tier TEXT NOT NULL DEFAULT 'shared',
          namespace TEXT,
          embedding F32_BLOB(${embedder.dim})
        );
      `);
      // Additive scope columns for pre-existing DBs (CREATE TABLE IF NOT EXISTS won't add them).
      // Idempotent: a duplicate-column error means an already-migrated DB; any other error surfaces later.
      for (const ddl of [
        `ALTER TABLE lessons ADD COLUMN tier TEXT NOT NULL DEFAULT 'shared'`,
        `ALTER TABLE lessons ADD COLUMN namespace TEXT`,
      ]) {
        try {
          await client.execute(ddl);
        } catch {
          /* already migrated */
        }
      }
      await client.execute(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts
        USING fts5(id UNINDEXED, content, tags, source);
      `);
      try {
        await client.execute(`
          CREATE INDEX IF NOT EXISTS idx_lessons_vec
          ON lessons (libsql_vector_idx(embedding));
        `);
      } catch {
        // index is optional; ordering by vector_distance_cos still works.
      }
    },

    embed: (text) => embedder.embed(text),

    async recall(query, k, scope) {
      if (!client) throw new Error('libsql-store: not initialized');
      const safeMatch = ftsEscape(query);
      const vec = await embedder.embed(query);
      const semantic: RecallHit[] = [];
      const lexical: RecallHit[] = [];
      // Scope filter at the STORE (the real boundary): a row is eligible iff it is `shared` OR its
      // namespace matches the recall scope. A null scope namespace binds `namespace = NULL` (always
      // false in SQL) → only `shared` rows match → fail-closed. `ns` is the bound param for both legs.
      const ns = scope.namespace;

      if (vec) {
        try {
          const rs = await client.execute({
            sql: `SELECT id, content, tags, source, author, created_at, derived_from, consumed_by_user_lessons, tier, namespace
                  FROM lessons
                  WHERE embedding IS NOT NULL AND (tier = 'shared' OR namespace = ?)
                  ORDER BY vector_distance_cos(embedding, vector32(?)) ASC
                  LIMIT ?`,
            args: [ns, JSON.stringify(vec), k],
          });
          rs.rows.forEach((r, i) =>
            semantic.push({ lesson: rowToLesson(r), score: 1 / (i + 1), source: 'semantic' }),
          );
        } catch {
          // Vector path unavailable on this libsql build — proceed lexical-only.
        }
      }
      // Empty / all-stripped query → skip lexical leg.
      if (safeMatch) {
        try {
          const lex = await client.execute({
            sql: `SELECT l.id, l.content, l.tags, l.source, l.author, l.created_at,
                  l.derived_from, l.consumed_by_user_lessons, l.tier, l.namespace
                  FROM lessons_fts f JOIN lessons l ON l.id = f.id
                  WHERE lessons_fts MATCH ? AND (l.tier = 'shared' OR l.namespace = ?)
                  LIMIT ?`,
            args: [safeMatch, ns, k],
          });
          lex.rows.forEach((r, i) =>
            lexical.push({ lesson: rowToLesson(r), score: 1 / (i + 1), source: 'lexical' }),
          );
        } catch {
          // Malformed FTS5 expression slipped through — return semantic only.
        }
      }

      // Post-filter via the authoritative pure predicate — a backstop so the SQL WHERE and the rule
      // can never silently diverge (defense in depth; the isolation test asserts both).
      return rrfFuse([semantic, lexical], k).filter((h) =>
        inScope(h.lesson.tier, h.lesson.namespace, scope),
      );
    },

    async storeLesson(lesson) {
      if (!client) throw new Error('libsql-store: not initialized');
      // File-first: write the per-file source-of-truth (atomic) before the derived DB index, so a
      // crash leaves the durable git-versionable truth intact and the DB is reconstructable.
      if (opts.sourceDir !== undefined) await writeRecord(opts.sourceDir, lesson);
      const vec = await embedder.embed(lesson.content);
      const tagsJson = JSON.stringify(lesson.tags);
      // Idempotent upsert by id: re-storing a lesson with the same id (e.g. a
      // re-memorize of the same body — id is the content-hash) REPLACES the prior
      // row instead of raising a PRIMARY KEY conflict. Delete-then-insert covers
      // both the main table and the contentless FTS index (FTS5 has no PK for
      // INSERT OR REPLACE to key on), keeping the two in lockstep.
      await client.execute({ sql: `DELETE FROM lessons WHERE id = ?`, args: [lesson.id] });
      await client.execute({ sql: `DELETE FROM lessons_fts WHERE id = ?`, args: [lesson.id] });
      const derivedFromJson = JSON.stringify(lesson.derivedFrom ?? []);
      const consumed = lesson.consumedByUserLessons ?? 0;
      const tier: MemoryTier = lesson.tier ?? 'shared';
      const namespace = lesson.namespace ?? null;
      await client.execute({
        sql: `INSERT INTO lessons (id, content, tags, source, author, created_at, derived_from,
              consumed_by_user_lessons, tier, namespace, embedding)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${vec ? 'vector32(?)' : 'NULL'})`,
        args: vec
          ? [
              lesson.id,
              lesson.content,
              tagsJson,
              lesson.source,
              lesson.author,
              lesson.createdAt,
              derivedFromJson,
              consumed,
              tier,
              namespace,
              JSON.stringify(vec),
            ]
          : [
              lesson.id,
              lesson.content,
              tagsJson,
              lesson.source,
              lesson.author,
              lesson.createdAt,
              derivedFromJson,
              consumed,
              tier,
              namespace,
            ],
      });
      await client.execute({
        sql: `INSERT INTO lessons_fts (id, content, tags, source) VALUES (?, ?, ?, ?)`,
        args: [lesson.id, lesson.content, tagsJson, lesson.source],
      });
    },

    async deleteLesson(id: string, delOpts?: { force?: boolean }): Promise<DeleteResult> {
      if (!client) throw new Error('libsql-store: not initialized');
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
      // Remove the per-file source too, else a later rebuild would resurrect the row.
      if (opts.sourceDir !== undefined) await deleteRecord(opts.sourceDir, id);
      return { deleted: true, forced: isUser && force };
    },
  };
}

/**
 * Rebuild the libSQL index from the per-file source-of-truth (the files are authoritative; the
 * DB is disposable). Drops + recreates the index tables first so records deleted from the source
 * don't linger, then re-indexes every record. Idempotent — a crash mid-rebuild is recovered by
 * re-running it (the source is never touched). Cold-path maintenance op (e.g. after a git
 * pull/merge of the source); for file-backed `dbUrl`s, not `:memory:`.
 */
export async function rebuildLibsqlIndex(opts: {
  dbUrl: string;
  embedder: Embedder;
  sourceDir: string;
}): Promise<number> {
  const client = createClient({ url: opts.dbUrl });
  await client.execute('DROP TABLE IF EXISTS lessons');
  await client.execute('DROP TABLE IF EXISTS lessons_fts');
  client.close();
  // No sourceDir on the rebuild backend → storeLesson re-indexes the DB only (it must NOT
  // rewrite the files it is reading from).
  const backend = libsqlStoreBackend({ dbUrl: opts.dbUrl, embedder: opts.embedder });
  await backend.init();
  const records = await readRecords(opts.sourceDir);
  for (const r of records) await backend.storeLesson(r);
  return records.length;
}

// FTS5 escape: tokenize on whitespace, strip non-`[\p{L}\p{N}_]`, OR the survivors. `''` means
// the caller skips the lexical leg. Exported so the wedge lesson store (src/rag/wedge) reuses the
// one FTS-escape rule instead of duplicating it.
export function ftsEscape(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 0);
  return tokens.length === 0 ? '' : tokens.join(' OR ');
}

function s(r: Row, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v : '';
}
function n(r: Row, key: string): number {
  const v = r[key];
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0;
}
function rowToLesson(r: Row): Lesson {
  return {
    id: s(r, 'id'),
    content: s(r, 'content'),
    tags: JSON.parse(s(r, 'tags') || '[]') as string[],
    source: s(r, 'source'),
    author: s(r, 'author') === 'user' ? 'user' : 'agent',
    createdAt: s(r, 'created_at'),
    derivedFrom: JSON.parse(s(r, 'derived_from') || '[]') as string[],
    consumedByUserLessons: n(r, 'consumed_by_user_lessons'),
    tier: s(r, 'tier') === 'project' ? 'project' : 'shared',
    namespace: typeof r.namespace === 'string' ? r.namespace : null,
  };
}

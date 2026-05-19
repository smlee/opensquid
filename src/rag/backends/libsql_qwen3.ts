/**
 * Default RAG backend: libsql storage + Qwen3 embeddings (hybrid semantic +
 * lexical via RRF).
 *
 * Per `docs/opensquid-real-design.md` §"Pluggable RAG backend" and
 * `project_opensquid_db_choice` (libsql) + `project_loop_embedder_choice`
 * (Qwen3-Embedding-4B via Ollama). The hybrid two-channel design (vector
 * cosine + FTS5 keyword) catches both semantic-near misses and exact-term
 * matches; RRF fusion balances them without per-domain tuning.
 *
 * Degraded mode: if the first `embed()` call throws (Ollama down / model
 * not pulled / network), `embedderUp` flips to `false` and subsequent
 * calls short-circuit to `null` without retrying — `recall()` becomes
 * lexical-only, `storeLesson()` writes `embedding NULL`. Retrying every
 * call would burn the user's worst-case latency for the whole session.
 *
 * Schema notes (libsql vector ext, @libsql/client 0.14): `F32_BLOB(dim)`
 * stores 32-bit float vectors; `vector32('[...]')` parses a JSON array
 * literal; `vector_distance_cos(a,b)` returns `1 - cosine_similarity`;
 * `libsql_vector_idx(col)` builds the DiskANN ANN index. If the syntax
 * shifts post-Phase-1 only this file changes — RagBackend is stable.
 *
 * FTS5 escape: tokenize on whitespace, strip non-`[\p{L}\p{N}_]`, drop
 * empty tokens, OR the survivors. Bulletproof against `*` / `-` / `"`;
 * matches casual-user intent ("any of these words"). Empty input → ''
 * so the caller skips the lexical leg.
 *
 * Imports from: @libsql/client, ../ollama_client.js, ../rrf.js, ../types.js.
 * Imported by: src/rag/backend_factory.ts.
 */

import { type Client, type Row, createClient } from '@libsql/client';

import { QWEN3_DIM, ollamaEmbed } from '../ollama_client.js';
import { rrfFuse } from '../rrf.js';

import type { Lesson, RagBackend, RecallHit } from '../types.js';

export interface LibsqlQwen3Opts {
  dbUrl: string;
  ollamaUrl: string;
  embedderModel?: string;
}

export function libsqlQwen3Backend(opts: LibsqlQwen3Opts): RagBackend {
  let client: Client | null = null;
  let embedderUp = true;

  async function embed(text: string): Promise<number[] | null> {
    if (!embedderUp) return null;
    try {
      return opts.embedderModel === undefined
        ? await ollamaEmbed(opts.ollamaUrl, text)
        : await ollamaEmbed(opts.ollamaUrl, text, opts.embedderModel);
    } catch {
      embedderUp = false;
      return null;
    }
  }

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
          embedding F32_BLOB(${QWEN3_DIM})
        );
      `);
      // FTS5 self-contained (not external-content): external-content needs
      // hand-written triggers to mirror writes; Phase 1 trades O(N) extra
      // storage for a simpler correctness story. Revisit in Phase 2 if
      // duplicate storage shows up in a profile.
      await client.execute(`
        CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts
        USING fts5(id UNINDEXED, content, tags, source);
      `);
      // Vector ANN index — tolerate failure: older libsql builds and :memory:
      // without the extension fall back to a full-table cosine scan.
      try {
        await client.execute(`
          CREATE INDEX IF NOT EXISTS idx_lessons_vec
          ON lessons (libsql_vector_idx(embedding));
        `);
      } catch {
        // index is optional; ordering by vector_distance_cos still works.
      }
    },

    embed,

    async recall(query, k) {
      if (!client) throw new Error('libsql-qwen3: not initialized');
      const safeMatch = ftsEscape(query);
      const vec = await embed(query);
      const semantic: RecallHit[] = [];
      const lexical: RecallHit[] = [];

      if (vec) {
        try {
          const rs = await client.execute({
            sql: `SELECT id, content, tags, source, author, created_at
                  FROM lessons
                  WHERE embedding IS NOT NULL
                  ORDER BY vector_distance_cos(embedding, vector32(?)) ASC
                  LIMIT ?`,
            args: [JSON.stringify(vec), k],
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
            sql: `SELECT l.id, l.content, l.tags, l.source, l.author, l.created_at
                  FROM lessons_fts f JOIN lessons l ON l.id = f.id
                  WHERE lessons_fts MATCH ?
                  LIMIT ?`,
            args: [safeMatch, k],
          });
          lex.rows.forEach((r, i) =>
            lexical.push({ lesson: rowToLesson(r), score: 1 / (i + 1), source: 'lexical' }),
          );
        } catch {
          // Malformed FTS5 expression slipped through — return semantic only.
        }
      }

      return rrfFuse([semantic, lexical], k);
    },

    async storeLesson(lesson) {
      if (!client) throw new Error('libsql-qwen3: not initialized');
      const vec = await embed(lesson.content);
      const tagsJson = JSON.stringify(lesson.tags);
      await client.execute({
        sql: `INSERT INTO lessons (id, content, tags, source, author, created_at, embedding)
              VALUES (?, ?, ?, ?, ?, ?, ${vec ? 'vector32(?)' : 'NULL'})`,
        args: vec
          ? [
              lesson.id,
              lesson.content,
              tagsJson,
              lesson.source,
              lesson.author,
              lesson.createdAt,
              JSON.stringify(vec),
            ]
          : [lesson.id, lesson.content, tagsJson, lesson.source, lesson.author, lesson.createdAt],
      });
      // Mirror into FTS5 as a separate statement (not a trigger) so the
      // backend stays portable to libsql builds without trigger support.
      await client.execute({
        sql: `INSERT INTO lessons_fts (id, content, tags, source) VALUES (?, ?, ?, ?)`,
        args: [lesson.id, lesson.content, tagsJson, lesson.source],
      });
    },
  };
}

// FTS5 escape: see header. `''` means caller skips the lexical leg.
function ftsEscape(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 0);
  return tokens.length === 0 ? '' : tokens.join(' OR ');
}

// All lesson columns are declared TEXT — libsql returns plain string; the
// guard catches schema drift at the boundary rather than at the use site.
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

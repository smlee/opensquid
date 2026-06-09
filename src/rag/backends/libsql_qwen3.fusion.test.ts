/**
 * T-LQ3T LQ3T.1 — Q10 RRF-fusion case for `libsqlQwen3Backend`.
 *
 * Factored to its own file because `vi.mock('@libsql/client', ...)` HOISTS
 * to file top — applying it in `libsql_qwen3.test.ts` would pollute the
 * Q1-Q9 + Q11-Q12 cases that use a real `:memory:` Client. Keeping Q10
 * isolated here is the production-grade path per T-libsql-qwen3-test.md
 * Phase-7 fix step.
 *
 * Q10: recall hybrid path RRF-fuses both channels (source === 'fused').
 *
 * Strategy:
 *   - vi.mock('@libsql/client') with a Client whose `execute` dispatches
 *     by SQL substring:
 *       - 'vector_distance_cos' → return canned semantic hits
 *       - 'lessons_fts MATCH'   → return canned lexical hits
 *       - else (CREATE TABLE, INSERT, etc.) → no-op + empty ResultSet
 *   - fetch stub returns the canned vec so `embed()` succeeds → semantic
 *     leg actually fires.
 *   - Seed two lessons: 'a' shows up in BOTH semantic + lexical canned
 *     results; 'b' shows up in lexical only; 'c' shows up in semantic
 *     only. Verifies the rrfFuse Map-union: all three appear with
 *     `source: 'fused'`, and the doubly-hit 'a' ranks highest.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { QWEN3_DIM } from '../ollama_client.js';

import type { Lesson } from '../types.js';

// ---------------------------------------------------------------------------
// Canned ResultSet rows, exposed as module-level mutable so the mocked
// `execute` dispatcher reads them at call time (after the test body has
// set them up). vi.mock's factory is HOISTED so it can't reference
// non-module-level state directly.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  content: string;
  tags: string;
  source: string;
  author: string;
  created_at: string;
}

interface CannedRows {
  semantic: Row[];
  lexical: Row[];
}

const canned: CannedRows = { semantic: [], lexical: [] };

function rowFor(l: Lesson): Row {
  return {
    id: l.id,
    content: l.content,
    tags: JSON.stringify(l.tags),
    source: l.source,
    author: l.author,
    created_at: l.createdAt,
  };
}

function mkLesson(id: string, content: string, tags: string[] = []): Lesson {
  return {
    id,
    content,
    tags,
    source: 'test',
    author: 'agent',
    createdAt: '2026-05-29T00:00:00.000Z',
  };
}

vi.mock('@libsql/client', () => {
  return {
    createClient: vi.fn(() => {
      return {
        execute(arg: string | { sql: string; args?: unknown[] }): Promise<unknown> {
          const sql = typeof arg === 'string' ? arg : arg.sql;
          if (sql.includes('vector_distance_cos')) {
            return Promise.resolve({
              rows: canned.semantic,
              columns: ['id', 'content', 'tags', 'source', 'author', 'created_at'],
              columnTypes: [],
              rowsAffected: 0,
              lastInsertRowid: undefined,
              toJSON: () => ({}),
            });
          }
          if (sql.includes('lessons_fts MATCH')) {
            return Promise.resolve({
              rows: canned.lexical,
              columns: ['id', 'content', 'tags', 'source', 'author', 'created_at'],
              columnTypes: [],
              rowsAffected: 0,
              lastInsertRowid: undefined,
              toJSON: () => ({}),
            });
          }
          // CREATE TABLE / CREATE INDEX / INSERT / etc. — no-op + empty.
          return Promise.resolve({
            rows: [],
            columns: [],
            columnTypes: [],
            rowsAffected: 0,
            lastInsertRowid: undefined,
            toJSON: () => ({}),
          });
        },
      };
    }),
  };
});

// Import AFTER vi.mock so the backend gets the mocked client. The mock
// itself is hoisted; ESM imports run after vi.mock processing.
const { libsqlQwen3Backend } = await import('./libsql_qwen3.js');

// ---------------------------------------------------------------------------
// Fetch stub for ollamaEmbed.
// ---------------------------------------------------------------------------

function fakeVec(): number[] {
  return Array.from({ length: QWEN3_DIM }, (_, i) => (i % 13) / 13);
}

function successFetch(): ReturnType<typeof vi.fn> {
  const vec = fakeVec();
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ embeddings: [vec] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Q10 — RRF-fused hybrid recall
// ---------------------------------------------------------------------------

describe('libsqlQwen3Backend RRF fusion (Q10)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    canned.semantic = [];
    canned.lexical = [];
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('Q10: recall fuses both channels (source === "fused"; doubly-hit ranks top)', async () => {
    global.fetch = successFetch();

    const a = mkLesson('a', 'shared workflow');
    const b = mkLesson('b', 'lexical-only workflow phase');
    const c = mkLesson('c', 'semantic-only neighbor');

    // 'a' in both channels; 'c' semantic-only; 'b' lexical-only.
    canned.semantic = [rowFor(a), rowFor(c)];
    canned.lexical = [rowFor(a), rowFor(b)];

    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();

    const hits = await backend.recall('workflow', 10, { namespace: null });

    const ids = hits.map((h) => h.lesson.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
    expect(hits.every((h) => h.source === 'fused')).toBe(true);
    // Doubly-hit ('a' in both lists at rank 1) outscores singly-hits.
    expect(ids[0]).toBe('a');
    // Single-hit ranking (between 'b' lexical-rank-2 and 'c' semantic-rank-2)
    // is implementation-dependent on tie-break order; the load-bearing
    // assertion is that BOTH appear in the fused result + 'a' tops them.
  });

  it('Q10b: empty semantic channel still returns lexical-only fused result', async () => {
    global.fetch = successFetch();

    const a = mkLesson('a', 'lexical-only');
    canned.semantic = [];
    canned.lexical = [rowFor(a)];

    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();

    const hits = await backend.recall('lexical', 10, { namespace: null });
    expect(hits.map((h) => h.lesson.id)).toEqual(['a']);
    expect(hits[0]?.source).toBe('fused');
  });
});

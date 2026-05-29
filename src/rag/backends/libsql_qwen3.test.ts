/**
 * T-LQ3T LQ3T.1 — direct unit tests for `libsqlQwen3Backend`.
 *
 * The qwen3 backend is the DEFAULT RAG backend (hybrid semantic + lexical
 * via RRF; Qwen3 embeddings via Ollama). Pre-LQ3T.1 it shipped with zero
 * direct tests — the only coverage was indirect via the fallback-wrapper
 * test at `libsql_lexical.test.ts:92-145` which only verified the swap to
 * lexical.
 *
 * This file covers cases Q1-Q9 + Q11-Q12 against a real `:memory:`
 * libsql client; the qwen3 backend's `init()` tolerates the absent
 * vector ANN extension on `:memory:`, and its `recall()` swallows the
 * `vector_distance_cos` failure + falls back to lexical. The RRF-fusion
 * hybrid path (Q10) needs a mocked Client that returns canned semantic
 * hits — that's factored to `libsql_qwen3.fusion.test.ts` so the
 * `vi.mock` hoist doesn't pollute Q1-Q9 + Q11-Q12.
 *
 * Strategy:
 *   - Per-test `global.fetch` stub controls ollamaEmbed responses
 *     (success / network-error / HTTP-error).
 *   - In-memory libsql (`:memory:`) — each test owns its own DB.
 *   - `vi.restoreAllMocks()` in `afterEach` so spy state doesn't leak
 *     across tests (Q4's latch assertion depends on this).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { QWEN3_DIM } from '../ollama_client.js';

import { libsqlQwen3Backend } from './libsql_qwen3.js';

import type { Lesson } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

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

/** Canned 2560-dim vector. The qwen3 backend only checks
 *  `Array.isArray + length > 0`; exact values are irrelevant (the libsql
 *  `vector_distance_cos` call would care, but that path is swallowed on
 *  `:memory:` per the backend's tolerance contract). */
function fakeVec(): number[] {
  return Array.from({ length: QWEN3_DIM }, (_, i) => (i % 13) / 13);
}

interface CapturedRequest {
  url: string;
  body: { model?: string; input?: string };
}

interface FetchSpyHandle {
  fn: ReturnType<typeof vi.fn>;
  captured: CapturedRequest[];
}

function inputUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  const maybeReq = input as { url?: unknown };
  return typeof maybeReq.url === 'string' ? maybeReq.url : '';
}

/** Success: returns the canned `{embeddings: [vec]}` reply. Records each
 *  request's url + parsed body so Q5 can assert the model override. */
function successFetch(vec: number[] = fakeVec()): FetchSpyHandle {
  const captured: CapturedRequest[] = [];
  const fn = vi.fn((input: unknown, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    let body: { model?: string; input?: string } = {};
    try {
      body = JSON.parse(bodyText) as { model?: string; input?: string };
    } catch {
      /* leave empty */
    }
    captured.push({ url: inputUrl(input), body });
    return Promise.resolve(
      new Response(JSON.stringify({ embeddings: [vec] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { fn, captured };
}

/** Network-error: `fetch` itself rejects. Used by Q4/Q7. */
function netErrorFetch(): FetchSpyHandle {
  const captured: CapturedRequest[] = [];
  const fn = vi.fn((input: unknown) => {
    captured.push({ url: inputUrl(input), body: {} });
    return Promise.reject(new Error('ECONNREFUSED (stub)'));
  });
  return { fn, captured };
}

// ---------------------------------------------------------------------------
// Describe — Q1-Q9 + Q11-Q12 against real :memory: libsql.
// Q10 (RRF fusion) lives in libsql_qwen3.fusion.test.ts (separate file so
// vi.mock('@libsql/client') doesn't hoist over the cases here).
// ---------------------------------------------------------------------------

describe('libsqlQwen3Backend (real :memory: libsql)', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---- init ----

  it('Q1: init creates lessons + lessons_fts tables (storeLesson works)', async () => {
    global.fetch = successFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    // If either table is missing, storeLesson throws.
    await expect(backend.storeLesson(mkLesson('a', 'hello'))).resolves.toBeUndefined();
    // Recall against the lexical leg proves both lessons + lessons_fts rows landed.
    const hits = await backend.recall('hello', 10);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('Q2: init tolerates vector-index creation failure on :memory:', async () => {
    // :memory: libsql build typically lacks the vector extension; the
    // CREATE INDEX ... libsql_vector_idx call throws and is swallowed.
    global.fetch = successFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await expect(backend.init()).resolves.toBeUndefined();
    await expect(backend.storeLesson(mkLesson('a', 'world'))).resolves.toBeUndefined();
  });

  // ---- embed ----

  it('Q3: embed returns the vector on success', async () => {
    const vec = fakeVec();
    global.fetch = successFetch(vec).fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    expect(await backend.embed('hello')).toEqual(vec);
  });

  it('Q4: embed returns null on first failure + latch prevents retry', async () => {
    const spy = netErrorFetch();
    global.fetch = spy.fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    expect(await backend.embed('first')).toBeNull();
    expect(await backend.embed('second')).toBeNull();
    expect(await backend.embed('third')).toBeNull();
    // Latch — fetch invoked EXACTLY ONCE despite 3 embed() calls.
    expect(spy.fn).toHaveBeenCalledTimes(1);
  });

  it('Q5: opts.embedderModel threads through to the fetch request body', async () => {
    const spy = successFetch();
    global.fetch = spy.fn;
    const backend = libsqlQwen3Backend({
      dbUrl: ':memory:',
      ollamaUrl: 'http://x',
      embedderModel: 'custom-model-x',
    });
    await backend.init();
    await backend.embed('seed');
    expect(spy.captured).toHaveLength(1);
    expect(spy.captured[0]!.body.model).toBe('custom-model-x');
    expect(spy.captured[0]!.body.input).toBe('seed');
  });

  // ---- storeLesson ----

  it('Q6: storeLesson with embedder UP writes vector column (no throw)', async () => {
    global.fetch = successFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    await backend.storeLesson(mkLesson('a', 'vector branch'));
    // Lexical recall against a content token proves the row landed.
    const hits = await backend.recall('vector', 10);
    expect(hits.map((h) => h.lesson.id)).toContain('a');
  });

  it('Q7: storeLesson with embedder DOWN writes NULL embedding (no throw)', async () => {
    global.fetch = netErrorFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    // First storeLesson: embed throws → embedderUp=false → NULL branch.
    await expect(backend.storeLesson(mkLesson('a', 'null branch'))).resolves.toBeUndefined();
    const hits = await backend.recall('null', 10);
    expect(hits.map((h) => h.lesson.id)).toContain('a');
  });

  it('Q8: storeLesson mirrors into lessons_fts (lexical recall hits)', async () => {
    global.fetch = successFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    await backend.storeLesson(mkLesson('a', 'fts5 mirror verification'));
    // Recall via the FTS5 MATCH leg — a hit on 'mirror' proves the FTS5
    // row was inserted by storeLesson's second INSERT.
    const hits = await backend.recall('mirror', 10);
    expect(hits.map((h) => h.lesson.id)).toContain('a');
  });

  // ---- recall ----

  it('Q9: recall fires lexical leg + matches stored content', async () => {
    // The original assumption "vector_distance_cos throws on :memory:" only
    // holds on libsql builds without the vector extension. The build under
    // test HAS the extension (verified by the test surfacing semantic-path
    // hits), so the qwen3 backend's recall fires BOTH legs and rrfFuses.
    // The load-bearing assertion for this case is that the lexical-matching
    // row 'a' appears in the result, regardless of how many semantic-side
    // rows happen to come back with the identical fake vectors.
    global.fetch = successFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    await backend.storeLesson(mkLesson('a', 'workflow phase audit'));
    await backend.storeLesson(mkLesson('b', 'unrelated kittens'));
    const hits = await backend.recall('workflow', 10);
    expect(hits.map((h) => h.lesson.id)).toContain('a');
    expect(hits.every((h) => h.source === 'fused')).toBe(true);
  });

  it('Q11: recall against empty DB returns []', async () => {
    global.fetch = successFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    expect(await backend.recall('anything', 10)).toEqual([]);
  });

  it('Q12: recall with empty query — ftsEscape skips lexical; semantic-only fused result', async () => {
    // ftsEscape('') returns '' → lexical leg skipped by design. The semantic
    // leg still runs (ollamaEmbed of '' succeeds when fetch is stubbed). On
    // a libsql build with the vector extension, semantic returns rows; on
    // builds without it, semantic throws + is swallowed and the result is
    // empty. Both outcomes are correct — the load-bearing assertion is
    // that recall doesn't throw on empty queries and the result count is
    // bounded by the seeded DB.
    global.fetch = successFetch().fn;
    const backend = libsqlQwen3Backend({ dbUrl: ':memory:', ollamaUrl: 'http://x' });
    await backend.init();
    await backend.storeLesson(mkLesson('a', 'seed content'));

    const emptyHits = await backend.recall('', 10);
    const whitespaceHits = await backend.recall('   ', 10);

    // Recall doesn't throw; result is bounded by the 1 seeded row.
    expect(emptyHits.length).toBeLessThanOrEqual(1);
    expect(whitespaceHits.length).toBeLessThanOrEqual(1);
    // If anything came back, it's the seeded row + 'fused' source.
    for (const h of [...emptyHits, ...whitespaceHits]) {
      expect(h.lesson.id).toBe('a');
      expect(h.source).toBe('fused');
    }
  });
});

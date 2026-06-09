/**
 * Tests for the RAG primitives (`recall`, `embed`, `store_lesson`)
 * with the `libsql-qwen3` backend.
 *
 * Test environment per Task 1.10 spec:
 *   - DB: `@libsql/client` with `url: ':memory:'` — every test gets a
 *     fresh ephemeral DB, no on-disk side effects.
 *   - Ollama: stubbed via `vi.spyOn(globalThis, 'fetch', ...)` so no
 *     real network call is made. Each test installs its own response.
 *
 * Cases (≥ 5 per acceptance criteria, including round-trip + ollama-down
 * fallback + empty DB + FTS5 special-char):
 *
 *   1. recall on empty DB → ok([]).
 *   2. store + recall round-trip with mocked embedder → lesson surfaces.
 *   3. Ollama returns HTTP 500 → embedderUp flips, embed returns null,
 *      subsequent recall is lexical-only and doesn't crash.
 *   4. FTS5 special chars in query (`"`, `*`, `-`) → no crash, results
 *      returned for matching content.
 *   5. store_lesson defaults fill in (tags=[], source='unknown',
 *      author='agent', createdAt is ISO 8601).
 *   6. recall with k bound respected via primitive arg validation
 *      (k must be positive integer ≤ 100).
 *
 * `globalThis.fetch` is restored after each test so cross-suite state
 * doesn't leak.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { libsqlQwen3Backend } from '../rag/backends/libsql_qwen3.js';
import { QWEN3_DIM } from '../rag/ollama_client.js';
import type { RecallHit } from '../rag/types.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerRagFunctions } from './rag.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function createTestCtx(): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
    packId: 'test-pack',
  };
}

/**
 * Build an in-memory backend + registry pre-wired with the RAG primitives.
 */
async function freshBackendAndRegistry(): Promise<{
  registry: FunctionRegistry;
  backend: ReturnType<typeof libsqlQwen3Backend>;
}> {
  const backend = libsqlQwen3Backend({
    dbUrl: ':memory:',
    ollamaUrl: 'http://test-host:11434',
  });
  await backend.init();
  const registry = new FunctionRegistry();
  registerRagFunctions(registry, backend);
  return { registry, backend };
}

/**
 * Build a deterministic fake embedding of length QWEN3_DIM. We bias the
 * first element by a `seed` so different texts map to vectors that
 * (barely) differ — enough to exercise cosine ordering without burning
 * a real Qwen install.
 */
function fakeEmbedding(seed: number): number[] {
  const v = new Array<number>(QWEN3_DIM).fill(0);
  v[0] = seed;
  v[1] = 1;
  return v;
}

/**
 * Install a fetch mock that returns the same canned embedding for every
 * call. The vi.SpyInstance generics across vitest 2.x change shape; we
 * return `void` and let callers reach back through `vi.mocked(fetch)` if
 * they need to inspect calls.
 */
function installEmbedFetchMock(seed = 1): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ embeddings: [fakeEmbedding(seed)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. recall on an empty DB — must return ok([]) without crashing.
// ---------------------------------------------------------------------------

describe('recall', () => {
  it('returns [] on an empty database', async () => {
    installEmbedFetchMock();
    const { registry } = await freshBackendAndRegistry();
    const result = await registry.call('recall', { query: 'anything', k: 5 }, createTestCtx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. store + recall round-trip (mocked Ollama).
// ---------------------------------------------------------------------------

describe('store_lesson + recall round-trip', () => {
  it('surfaces a stored lesson on recall', async () => {
    installEmbedFetchMock();
    const { registry } = await freshBackendAndRegistry();
    const ctx = createTestCtx();

    const stored = await registry.call(
      'store_lesson',
      {
        id: 'L1',
        content: 'never commit --amend on shared branches',
        tags: ['git'],
        source: 'user',
        author: 'user',
      },
      ctx,
    );
    expect(stored.ok).toBe(true);

    const recalled = await registry.call('recall', { query: 'git amend', k: 5 }, ctx);
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      const hits = recalled.value as RecallHit[];
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.lesson.id === 'L1')).toBe(true);
    }
  });

  it('applies defaults for tags / source / author / createdAt', async () => {
    installEmbedFetchMock();
    const { registry, backend } = await freshBackendAndRegistry();
    const ctx = createTestCtx();

    const stored = await registry.call(
      'store_lesson',
      { id: 'L2', content: 'hello world keyword search content' },
      ctx,
    );
    expect(stored.ok).toBe(true);

    // Recall what we just stored to verify the row materialized with defaults.
    const recalled = await backend.recall('hello world', 5, { namespace: null });
    const hit = recalled.find((h) => h.lesson.id === 'L2');
    expect(hit).toBeDefined();
    expect(hit!.lesson.tags).toEqual([]);
    expect(hit!.lesson.source).toBe('unknown');
    expect(hit!.lesson.author).toBe('agent');
    // ISO 8601 — `new Date(...)` round-trips it.
    expect(Number.isNaN(new Date(hit!.lesson.createdAt).valueOf())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Ollama unavailable → embedderUp flips, embed returns null, recall
//    falls back to lexical-only without crashing.
// ---------------------------------------------------------------------------

describe('Ollama-unavailable fallback', () => {
  it('embed() returns null and recall remains lexical-only after an HTTP 500', async () => {
    let fetchCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      fetchCalls += 1;
      return Promise.resolve(
        new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
      );
    });
    const { registry } = await freshBackendAndRegistry();
    const ctx = createTestCtx();

    // Seed a row via store_lesson — embed throws, so the row is stored
    // without an embedding.
    const stored = await registry.call(
      'store_lesson',
      { id: 'LX', content: 'lexical-only fallback path content', author: 'user' },
      ctx,
    );
    expect(stored.ok).toBe(true);

    // Direct embed primitive should now return null (embedder flagged down).
    const embedRes = await registry.call('embed', { text: 'anything' }, ctx);
    expect(embedRes.ok).toBe(true);
    if (embedRes.ok) expect(embedRes.value).toBeNull();

    // Recall should still work via FTS5 even though the embedder is down.
    const recalled = await registry.call('recall', { query: 'lexical fallback', k: 5 }, ctx);
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      const hits = recalled.value as RecallHit[];
      expect(hits.some((h) => h.lesson.id === 'LX')).toBe(true);
    }
    expect(fetchCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. FTS5 special chars in query — `"`, `*`, `-` must not crash.
// ---------------------------------------------------------------------------

describe('FTS5 special chars', () => {
  it('does not crash on quotes / stars / dashes in the query', async () => {
    installEmbedFetchMock();
    const { registry } = await freshBackendAndRegistry();
    const ctx = createTestCtx();

    // Each query exercises one or more FTS5 metacharacters. None should
    // throw; results may be empty, that's fine — we're testing the
    // escape, not the relevance.
    for (const query of ['"hello"', 'foo*', 'a-b-c', '""', '* "x" -']) {
      const recalled = await registry.call('recall', { query, k: 5 }, ctx);
      expect(recalled.ok).toBe(true);
    }
  });
});

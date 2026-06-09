/**
 * Tests for `libsqlLexicalBackend` + the qwen3→lexical fallback wrapper.
 *
 * In-memory libsql (`url: ':memory:'`) — every test gets a fresh backend.
 * No external Ollama; lexical backend has no embedder by definition, and
 * the fallback test stubs the primary so we never reach a real one.
 *
 * Coverage:
 *   1. storeLesson → recall round-trip matches by exact token.
 *   2. Empty query returns `[]` without throwing.
 *   3. FTS5 special chars (`"hello"*`) are sanitized — no syntax error.
 *   4. embed() always returns null.
 *   5. recall against an empty DB returns `[]`.
 *   6. Fallback wrapper: stubbed primary embed → null swaps to lexical,
 *      lexical recall continues to function after the swap.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { libsqlQwen3WithLexicalFallback } from '../backend_factory.js';

import { libsqlLexicalBackend } from './libsql_lexical.js';

import type { Lesson } from '../types.js';

function mkLesson(id: string, content: string, tags: string[] = []): Lesson {
  return {
    id,
    content,
    tags,
    source: 'test',
    author: 'agent',
    createdAt: '2026-05-19T00:00:00.000Z',
  };
}

describe('libsqlLexicalBackend', () => {
  it('round-trips: storeLesson + recall by exact token', async () => {
    const backend = libsqlLexicalBackend({ dbUrl: ':memory:' });
    await backend.init();

    await backend.storeLesson(mkLesson('a', 'workflow phase audit cycle', ['workflow']));
    await backend.storeLesson(mkLesson('b', 'unrelated content about kittens', ['cats']));
    await backend.storeLesson(mkLesson('c', 'workflow drift detection', ['workflow']));

    const hits = await backend.recall('workflow', 10, { namespace: null });

    const ids = hits.map((h) => h.lesson.id).sort();
    expect(ids).toEqual(['a', 'c']);
    expect(hits.every((h) => h.source === 'lexical')).toBe(true);
    // Ranks are 1/(i+1) descending — first hit's score must be >= the second's.
    if (hits.length > 1) {
      expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    }
  });

  it('returns [] for an empty query', async () => {
    const backend = libsqlLexicalBackend({ dbUrl: ':memory:' });
    await backend.init();
    await backend.storeLesson(mkLesson('a', 'some content'));

    expect(await backend.recall('', 10, { namespace: null })).toEqual([]);
    expect(await backend.recall('   ', 10, { namespace: null })).toEqual([]);
  });

  it('sanitizes FTS5 special chars without crashing', async () => {
    const backend = libsqlLexicalBackend({ dbUrl: ':memory:' });
    await backend.init();
    await backend.storeLesson(mkLesson('a', 'hello world from opensquid'));

    // Raw FTS5 would reject `"hello"*` as a syntax error — sanitizer drops
    // the `"` and `*`, leaving "hello" which matches the stored doc.
    const hits = await backend.recall('"hello"*', 10, { namespace: null });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.lesson.id).toBe('a');
  });

  it('embed() always returns null', async () => {
    const backend = libsqlLexicalBackend({ dbUrl: ':memory:' });
    await backend.init();
    expect(await backend.embed('anything')).toBeNull();
    expect(await backend.embed('')).toBeNull();
  });

  it('recall against an empty DB returns []', async () => {
    const backend = libsqlLexicalBackend({ dbUrl: ':memory:' });
    await backend.init();
    expect(await backend.recall('workflow', 10, { namespace: null })).toEqual([]);
  });
});

describe('libsqlQwen3WithLexicalFallback', () => {
  // The wrapper instantiates the real qwen3 backend, which would try to
  // reach Ollama on a real call. We don't want a live HTTP request in a
  // unit test, so we stub `fetch` to fail — the qwen3 backend catches the
  // error and returns null, which is the exact signal the wrapper listens
  // for. After the swap, all traffic goes to lexical (in-memory).
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('ollama unreachable (stub)'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('swaps to lexical on first null embed and continues to function', async () => {
    const stderrWrites: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });

    try {
      const wrapper = libsqlQwen3WithLexicalFallback({
        dbUrl: ':memory:',
        ollamaUrl: 'http://127.0.0.1:1', // any non-listening port; fetch is stubbed anyway
      });
      await wrapper.init();

      // First embed call → primary returns null (Ollama down) → swap fires.
      const v1 = await wrapper.embed('hello');
      expect(v1).toBeNull();
      expect(stderrWrites.join('')).toContain('falling back to lexical-only backend');

      // After swap, storeLesson + recall route through the lexical backend.
      // The lexical backend was just `init()`-ed during the swap, so the
      // table exists in this in-memory db.
      await wrapper.storeLesson(mkLesson('a', 'workflow phase audit'));
      const hits = await wrapper.recall('workflow', 10, { namespace: null });
      expect(hits.map((h) => h.lesson.id)).toEqual(['a']);

      // Second embed call: already swapped, lexical.embed() returns null,
      // and crucially we do NOT see a second "falling back" message.
      const beforeLen = stderrWrites.join('').length;
      const v2 = await wrapper.embed('anything');
      expect(v2).toBeNull();
      expect(stderrWrites.join('').length).toBe(beforeLen);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

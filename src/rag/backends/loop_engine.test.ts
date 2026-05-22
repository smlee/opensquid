/**
 * Tests for `loopEngineBackend` — the engine-backed RAG adapter.
 *
 * Mocks `EngineClient` so we don't need a live engine subprocess. The
 * spec's live integration test (cross-session memory write→read) lives
 * separately, gated on engine binary presence.
 *
 * Coverage (per T.3 spec lines 782-791):
 *   1. recall maps 3 hits with correct source vocab translation
 *      (semantic→semantic, text→lexical, both→fused, omitted→semantic).
 *   2. recall preserves `similarity` field as RecallHit.score.
 *   3. recall passes `mode: 'hybrid'` + `include_body: true` by default.
 *   4. recall honors override mode opt.
 *   5. embed delegates to ollamaEmbed; returns vector on success.
 *   6. embed catches throw + returns null (Ollama-down degraded path).
 *   7. storeLesson routes to memory.create (NOT lesson.create).
 *   8. storeLesson synthesizes description from first sentence.
 *   9. storeLesson falls back to first 80 chars when no sentence boundary.
 *  10. storeLesson falls back to 'untitled memory' on empty content.
 *  11. init calls client.ping().
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { EngineClient } from '../../engine/client.js';

import { loopEngineBackend } from './loop_engine.js';

import type { Lesson } from '../types.js';
import type {
  CreateMemoryResult,
  MemorySearchParams,
  MemorySearchResult,
} from '../../engine/types.js';

function mkLesson(content: string, id = 'a'): Lesson {
  return {
    id,
    content,
    tags: ['x'],
    source: 'test',
    author: 'agent',
    createdAt: '2026-05-22T00:00:00.000Z',
  };
}

describe('loopEngineBackend', () => {
  // Inject a fresh mock client per test so spy state doesn't leak.
  // Spy types are awkward to express across vitest versions; use the
  // method-bound MockInstance shape so .mockResolvedValueOnce + .mock.calls
  // round-trip cleanly.
  let client: EngineClient;
  let pingSpy: MockInstance<() => Promise<{ ok: true; version: string }>>;
  let searchSpy: MockInstance<(p: MemorySearchParams) => Promise<MemorySearchResult>>;
  let createSpy: MockInstance<
    (p: { description: string; content: string }) => Promise<CreateMemoryResult>
  >;

  beforeEach(() => {
    client = new EngineClient();
    pingSpy = vi.spyOn(client, 'ping').mockResolvedValue({ ok: true as const, version: '0.5.3' });
    searchSpy = vi.spyOn(client, 'memorySearch').mockResolvedValue({
      query: 'stub',
      returned: 0,
      results: [],
    });
    createSpy = vi.spyOn(client, 'memoryCreate').mockResolvedValue({
      id: 'mem-stub',
      description: 'stub',
      created_at: '2026-05-22T00:00:00.000Z',
      scope: 'user',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('init() pings the engine', async () => {
    const backend = loopEngineBackend({ client });
    await backend.init();
    expect(pingSpy).toHaveBeenCalledOnce();
  });

  it('recall maps 3 hits with correct source vocab translation', async () => {
    searchSpy.mockResolvedValueOnce({
      query: 'q',
      returned: 3,
      results: [
        {
          kind: 'memory',
          id: 'm1',
          description: 'first',
          body_preview: 'body one',
          similarity: 0.91,
          source: 'semantic',
        },
        {
          kind: 'memory',
          id: 'm2',
          description: 'second',
          body_preview: 'body two',
          similarity: 0.82,
          source: 'text',
        },
        {
          kind: 'memory',
          id: 'm3',
          description: 'third',
          body_preview: 'body three',
          similarity: 0.73,
          source: 'both',
        },
      ],
    });
    const backend = loopEngineBackend({ client });
    const hits = await backend.recall('q', 3);

    expect(hits).toHaveLength(3);
    expect(hits[0]!.source).toBe('semantic');
    expect(hits[1]!.source).toBe('lexical');
    expect(hits[2]!.source).toBe('fused');
    expect(hits[0]!.lesson.id).toBe('m1');
    expect(hits[0]!.lesson.content).toBe('body one');
  });

  it('recall defaults missing engine source to "semantic"', async () => {
    searchSpy.mockResolvedValueOnce({
      query: 'q',
      returned: 1,
      results: [
        {
          kind: 'memory',
          id: 'm1',
          description: 'first',
          body_preview: 'body one',
          similarity: 0.5,
          // source omitted (non-hybrid mode)
        },
      ],
    });
    const backend = loopEngineBackend({ client, mode: 'semantic' });
    const hits = await backend.recall('q', 1);
    expect(hits[0]!.source).toBe('semantic');
  });

  it('recall preserves similarity → score field mapping', async () => {
    searchSpy.mockResolvedValueOnce({
      query: 'q',
      returned: 1,
      results: [
        {
          kind: 'memory',
          id: 'mX',
          description: 'd',
          body_preview: 'b',
          similarity: 0.487,
          source: 'semantic',
        },
      ],
    });
    const backend = loopEngineBackend({ client });
    const hits = await backend.recall('q', 1);
    expect(hits[0]!.score).toBe(0.487);
  });

  it('recall sends mode=hybrid + include_body=true by default', async () => {
    const backend = loopEngineBackend({ client });
    await backend.recall('q', 5);
    expect(searchSpy).toHaveBeenCalledWith({
      query: 'q',
      limit: 5,
      mode: 'hybrid',
      include_body: true,
    });
  });

  it('recall honors mode override', async () => {
    const backend = loopEngineBackend({ client, mode: 'text' });
    await backend.recall('q', 2);
    expect(searchSpy).toHaveBeenCalledWith({
      query: 'q',
      limit: 2,
      mode: 'text',
      include_body: true,
    });
  });

  it('storeLesson routes to memory.create (NOT lesson.create)', async () => {
    const backend = loopEngineBackend({ client });
    await backend.storeLesson(mkLesson('short note'));
    expect(createSpy).toHaveBeenCalledOnce();
    expect(createSpy).toHaveBeenCalledWith({
      description: 'short note',
      content: 'short note',
    });
  });

  it('storeLesson synthesizes description from first sentence', async () => {
    const backend = loopEngineBackend({ client });
    await backend.storeLesson(mkLesson('Long sentence here. More text after.'));
    expect(createSpy).toHaveBeenCalledWith({
      description: 'Long sentence here',
      content: 'Long sentence here. More text after.',
    });
  });

  it('storeLesson falls back to first 80 chars when no sentence boundary', async () => {
    const longNoBoundary = 'x'.repeat(200);
    const backend = loopEngineBackend({ client });
    await backend.storeLesson(mkLesson(longNoBoundary));
    const call = createSpy.mock.calls[0]![0];
    expect(call.description.length).toBe(80);
    expect(call.description).toBe('x'.repeat(80));
  });

  it('storeLesson falls back to "untitled memory" for empty content', async () => {
    const backend = loopEngineBackend({ client });
    await backend.storeLesson(mkLesson(''));
    expect(createSpy).toHaveBeenCalledWith({
      description: 'untitled memory',
      content: '',
    });
  });

  describe('embed', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns vector on Ollama success', async () => {
      const vec = Array.from({ length: 2560 }, (_, i) => i / 2560);
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ embeddings: [vec] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const backend = loopEngineBackend({ client, ollamaUrl: 'http://127.0.0.1:11434' });
      const out = await backend.embed('hello');
      expect(out).toEqual(vec);
    });

    it('returns null on Ollama throw (degraded mode)', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('ollama unreachable'));
      const backend = loopEngineBackend({ client, ollamaUrl: 'http://127.0.0.1:11434' });
      const out = await backend.embed('hello');
      expect(out).toBeNull();
    });

    it('returns null on malformed Ollama response', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ embeddings: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const backend = loopEngineBackend({ client, ollamaUrl: 'http://127.0.0.1:11434' });
      const out = await backend.embed('hello');
      expect(out).toBeNull();
    });
  });
});

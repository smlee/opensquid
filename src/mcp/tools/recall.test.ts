/**
 * Unit tests for `handleRecall` — formatting + empty-result behavior.
 *
 * Subprocess + Zod validation behavior is covered by `src/mcp/server.test.ts`.
 * This file isolates the handler's text-output contract with a mocked
 * backend so we don't pay subprocess + libsql startup for the assertion
 * that 3 hits format as 3 lines joined by `\n\n` in the documented shape.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecallHit } from '../../rag/types.js';

import { handleRecall } from './recall.js';

vi.mock('../../rag/config.js', () => ({
  resolveBackendConfig: () => Promise.resolve({ kind: 'libsql-lexical', dbUrl: 'file::memory:' }),
}));

vi.mock('../../rag/backend_factory.js', () => ({
  createBackend: vi.fn(),
}));

// Fix the recall scope so the output is deterministic regardless of the test env's project context
// (a null namespace would prepend the fail-loud notice — env-dependent, which broke CI).
vi.mock('../../rag/scope.js', () => ({
  resolveRecallScope: () => Promise.resolve({ namespace: 'test-ns' }),
  NULL_SCOPE_NOTICE: 'NULL_SCOPE_NOTICE',
}));

function mkBackend(hits: RecallHit[]): {
  init: () => Promise<void>;
  embed: () => Promise<number[] | null>;
  recall: () => Promise<RecallHit[]>;
  storeLesson: () => Promise<void>;
  deleteLesson: () => Promise<{ deleted: boolean; forced: boolean }>;
} {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve(hits),
    storeLesson: () => Promise.resolve(),
    deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
  };
}

function mkHit(content: string, score: number, source: RecallHit['source']): RecallHit {
  return {
    lesson: {
      id: 'mem-' + Math.random().toString(36).slice(2, 10),
      content,
      tags: [],
      source: 'test',
      author: 'user',
      createdAt: '2026-05-22T00:00:00Z',
    },
    score,
    source,
  };
}

describe('handleRecall', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns "No memories found..." when the backend returns zero hits', async () => {
    const { createBackend } = await import('../../rag/backend_factory.js');
    vi.mocked(createBackend).mockReturnValue(mkBackend([]));

    const out = await handleRecall({ query: 'teddy' });
    expect(out).toBe('No memories found matching "teddy".');
  });

  it('formats one hit as "[1] (source, score=X.XXX) <content>"', async () => {
    const { createBackend } = await import('../../rag/backend_factory.js');
    vi.mocked(createBackend).mockReturnValue(
      mkBackend([mkHit('A lone memory about teddy bears.', 0.7421, 'semantic')]),
    );

    const out = await handleRecall({ query: 'teddy' });
    expect(out).toBe('[1] (semantic, score=0.742) A lone memory about teddy bears.');
  });

  it('formats three hits joined by blank lines, score rounded to 3 dp', async () => {
    const { createBackend } = await import('../../rag/backend_factory.js');
    vi.mocked(createBackend).mockReturnValue(
      mkBackend([
        mkHit('first', 0.9, 'semantic'),
        mkHit('second', 0.5, 'lexical'),
        mkHit('third', 0.123456, 'fused'),
      ]),
    );

    const out = await handleRecall({ query: 'anything' });
    expect(out).toBe(
      '[1] (semantic, score=0.900) first\n\n' +
        '[2] (lexical, score=0.500) second\n\n' +
        '[3] (fused, score=0.123) third',
    );
  });

  it('passes k through to backend.recall (default = 10)', async () => {
    const { createBackend } = await import('../../rag/backend_factory.js');
    const backend = mkBackend([]);
    const recallSpy = vi.spyOn(backend, 'recall');
    vi.mocked(createBackend).mockReturnValue(backend);

    await handleRecall({ query: 'q' });
    expect(recallSpy).toHaveBeenCalledWith('q', 10, expect.anything());

    recallSpy.mockClear();
    await handleRecall({ query: 'q', k: 5 });
    expect(recallSpy).toHaveBeenCalledWith('q', 5, expect.anything());
  });
});

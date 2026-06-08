/**
 * agent_bridge tools — recall unit tests (WAB.6, 0.5.100).
 *
 * Coverage:
 *   - spec declares the right shape
 *   - validator rejects empty query
 *   - validator rejects k out of bounds
 *   - handler defaults k to 5
 *   - handler formats hits into a readable string
 *   - handler returns "no results" sentinel on empty hit list
 *   - handler propagates backend errors
 */

import { describe, expect, it } from 'vitest';

import { makeRecallHandler, recallSpec } from './recall.js';
import type { RagBackend, RecallHit } from '../../../rag/types.js';
import type { ToolContext } from '../types.js';

const CTX: ToolContext = {
  sessionKey: { platform: 'telegram', chatId: '8075471258' },
  projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
};

function makeBackend(impl: Partial<RagBackend> = {}): RagBackend {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: () => Promise.resolve(),
    deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
    ...impl,
  };
}

function hit(id: string, score: number): RecallHit {
  return {
    lesson: {
      id,
      content: `lesson ${id} content`,
      tags: ['tag-a'],
      source: 'unit-test',
      author: 'user',
      createdAt: '2026-05-21T00:00:00.000Z',
    },
    score,
    source: 'fused',
  };
}

describe('recall.spec', () => {
  it('declares query as required and k as optional', () => {
    expect(recallSpec.name).toBe('recall');
    expect(recallSpec.input_schema).toMatchObject({
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('validator rejects empty query', () => {
    expect(() => recallSpec.validate?.({ query: '' })).toThrow();
  });

  it('validator rejects k=0', () => {
    expect(() => recallSpec.validate?.({ query: 'x', k: 0 })).toThrow();
  });

  it('validator rejects k>100', () => {
    expect(() => recallSpec.validate?.({ query: 'x', k: 200 })).toThrow();
  });
});

describe('makeRecallHandler', () => {
  it('defaults k to 5 when not provided', async () => {
    const calls: [string, number][] = [];
    const backend = makeBackend({
      recall: (q, k) => {
        calls.push([q, k]);
        return Promise.resolve([]);
      },
    });
    const handler = makeRecallHandler(backend);
    const validated = recallSpec.validate!({ query: 'memory test' });
    await handler(validated, CTX);
    expect(calls).toEqual([['memory test', 5]]);
  });

  it('formats hits with id + score + source + tags + content', async () => {
    const backend = makeBackend({
      recall: () => Promise.resolve([hit('a', 0.92), hit('b', 0.81)]),
    });
    const handler = makeRecallHandler(backend);
    const validated = recallSpec.validate!({ query: 'q', k: 2 });
    const out = await handler(validated, CTX);
    expect(out).toMatch(/id=a score=0.920 source=fused tags=\[tag-a\]/);
    expect(out).toMatch(/lesson a content/);
    expect(out).toMatch(/id=b score=0.810/);
  });

  it('returns a "no results" sentinel on empty hit list', async () => {
    const backend = makeBackend({ recall: () => Promise.resolve([]) });
    const handler = makeRecallHandler(backend);
    const validated = recallSpec.validate!({ query: 'nothing-here' });
    const out = await handler(validated, CTX);
    expect(out).toBe('no results for query="nothing-here"');
  });

  it('propagates backend errors', async () => {
    const backend = makeBackend({ recall: () => Promise.reject(new Error('db down')) });
    const handler = makeRecallHandler(backend);
    const validated = recallSpec.validate!({ query: 'q' });
    await expect(handler(validated, CTX)).rejects.toThrow(/db down/);
  });
});

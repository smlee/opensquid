/**
 * fastembedEmbedder unit tests — fast + deterministic (no model download, no Ollama).
 * The real end-to-end embed is proven by spike E0 (`loop/spikes/vec-bench/e0-fastembed.cjs`)
 * and validated for recall quality by the E2 parity harness (`scripts/e2-recall-parity.ts`).
 * Here we only assert the contract: the bge-small dimension + that the `libsql-fastembed`
 * factory arm wires to a well-formed RagBackend.
 */
import { describe, expect, it, vi } from 'vitest';

import { createBackend } from '../backend_factory.js';

import { fastembedEmbedder } from './fastembed.js';

// T-memory-lifecycle — mock the native `fastembed` so the per-call-isolation test is offline + deterministic.
const fe = vi.hoisted(() => ({ calls: 0 }));
vi.mock('fastembed', () => ({
  EmbeddingModel: { BGESmallENV15: 'bge-small' },
  FlagEmbedding: {
    init: () =>
      Promise.resolve({
        // eslint-disable-next-line @typescript-eslint/require-await
        async *embed(_texts: string[]) {
          fe.calls += 1;
          if (fe.calls === 1) throw new Error('transient embed failure');
          yield [[1, 0, 0, 0]];
        },
      }),
  },
}));

describe('fastembedEmbedder', () => {
  it('declares the bge-small-en-v1.5 dimension (384) without loading the model', () => {
    const e = fastembedEmbedder();
    expect(e.dim).toBe(384);
    expect(typeof e.embed).toBe('function');
  });
});

describe('libsql-fastembed factory arm', () => {
  it('createBackend wires libsql-fastembed to a well-formed RagBackend', () => {
    const backend = createBackend({ kind: 'libsql-fastembed', dbUrl: ':memory:' });
    expect(typeof backend.init).toBe('function');
    expect(typeof backend.embed).toBe('function');
    expect(typeof backend.recall).toBe('function');
    expect(typeof backend.storeLesson).toBe('function');
  });
});

describe('fastembedEmbedder — per-call failure isolation (no one-way latch)', () => {
  it('a transient failure nulls only that call; the next call still embeds', async () => {
    fe.calls = 0;
    const e = fastembedEmbedder();
    expect(await e.embed('first')).toBeNull(); // first call throws → null
    expect(await e.embed('second')).toEqual([1, 0, 0, 0]); // NOT permanently disabled
  });
});

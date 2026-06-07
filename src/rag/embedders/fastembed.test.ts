/**
 * fastembedEmbedder unit tests — fast + deterministic (no model download, no Ollama).
 * The real end-to-end embed is proven by spike E0 (`loop/spikes/vec-bench/e0-fastembed.cjs`)
 * and validated for recall quality by the E2 parity harness (`scripts/e2-recall-parity.ts`).
 * Here we only assert the contract: the bge-small dimension + that the `libsql-fastembed`
 * factory arm wires to a well-formed RagBackend.
 */
import { describe, expect, it } from 'vitest';

import { createBackend } from '../backend_factory.js';

import { fastembedEmbedder } from './fastembed.js';

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

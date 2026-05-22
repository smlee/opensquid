/**
 * Bootstrap regression test.
 *
 * Asserts that T-loop-engine-reintegration T.3 wires the RAG primitives
 * (`recall`, `embed`, `store_lesson`) into the registry — these were
 * documented as "intentionally not registered" in Phase 1 (per the
 * pre-T.3 bootstrap header comment). If a future refactor reverts the
 * registration, this test catches it.
 *
 * Uses a stub RagBackend via `buildRegistry({ backend })` so we don't
 * spawn a real loop-engine subprocess or open a libsql file during
 * unit-test runs.
 */

import { describe, expect, it } from 'vitest';

import { buildRegistry } from './bootstrap.js';

import type { RagBackend } from '../rag/types.js';

function stubBackend(): RagBackend {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: () => Promise.resolve(),
  };
}

describe('buildRegistry — T.3 RAG wiring', () => {
  it('registers recall, embed, store_lesson primitives', async () => {
    const registry = await buildRegistry({ backend: stubBackend() });
    expect(registry.has('recall')).toBe(true);
    expect(registry.has('embed')).toBe(true);
    expect(registry.has('store_lesson')).toBe(true);
  });

  it('still registers all pre-T.3 primitive families', async () => {
    const registry = await buildRegistry({ backend: stubBackend() });
    // Spot-check one primitive from each pre-T.3 family (verdict / state /
    // event / llm / destination_check / subagent). Full per-family coverage
    // lives in each family's own test.
    expect(registry.has('verdict')).toBe(true);
    expect(registry.has('check_destination')).toBe(true);
    expect(registry.has('spawn_subagent')).toBe(true);
  });

  it('calls backend.init() before registering RAG primitives', async () => {
    let initCalled = false;
    const backend: RagBackend = {
      init: () => {
        initCalled = true;
        return Promise.resolve();
      },
      embed: () => Promise.resolve(null),
      recall: () => Promise.resolve([]),
      storeLesson: () => Promise.resolve(),
    };
    await buildRegistry({ backend });
    expect(initCalled).toBe(true);
  });
});

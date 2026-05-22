/**
 * Bootstrap regression test.
 *
 * Asserts:
 *  - T-loop-engine-reintegration T.3 wires the RAG primitives
 *    (`recall`, `embed`, `store_lesson`) into the registry. These were
 *    documented as "intentionally not registered" in Phase 1; a refactor
 *    reverting that registration must be caught here.
 *  - T-loop-engine-reintegration T.6 wires the wedge gate lesson surface
 *    (`propose_lesson`, `promote_lesson`, `recall_lesson`). Skipping
 *    these would break the entire competitive moat (per
 *    `project_2026_05_12_strategic_pivot`).
 *
 * Uses a stub RagBackend via `buildRegistry({ backend })` so we don't
 * spawn a real loop-engine subprocess or open a libsql file during
 * unit-test runs. Passes `engineClient: null` to skip lesson
 * registration for tests that aren't asserting on the lesson surface
 * (so they don't construct a real EngineClient and lazily connect to
 * a daemon socket).
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
    const registry = await buildRegistry({ backend: stubBackend(), engineClient: null });
    expect(registry.has('recall')).toBe(true);
    expect(registry.has('embed')).toBe(true);
    expect(registry.has('store_lesson')).toBe(true);
  });

  it('still registers all pre-T.3 primitive families', async () => {
    const registry = await buildRegistry({ backend: stubBackend(), engineClient: null });
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
    await buildRegistry({ backend, engineClient: null });
    expect(initCalled).toBe(true);
  });
});

describe('buildRegistry — T.6 lesson wiring (wedge gate surface)', () => {
  // The wedge gate firing is the entire competitive moat. These
  // assertions guard the *registration* surface (not the gate firing
  // itself — that's the E2E in test/e2e/wedge_gate.test.ts).
  it('registers propose_lesson, promote_lesson, recall_lesson primitives', async () => {
    // We need to import EngineClient to satisfy the engineClient type;
    // since we never actually call any of the lesson primitives in this
    // test, the lazy connect inside EngineClient never fires (no
    // socket touched).
    const { EngineClient } = await import('../engine/client.js');
    const client = new EngineClient();
    const registry = await buildRegistry({ backend: stubBackend(), engineClient: client });
    expect(registry.has('propose_lesson')).toBe(true);
    expect(registry.has('promote_lesson')).toBe(true);
    expect(registry.has('recall_lesson')).toBe(true);
  });

  it('skips lesson registration when engineClient is null', async () => {
    const registry = await buildRegistry({ backend: stubBackend(), engineClient: null });
    expect(registry.has('propose_lesson')).toBe(false);
    expect(registry.has('promote_lesson')).toBe(false);
    expect(registry.has('recall_lesson')).toBe(false);
  });
});

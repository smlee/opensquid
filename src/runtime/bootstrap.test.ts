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
 * unit-test runs. Passes `lessonStore: null` to skip lesson
 * registration for tests that aren't asserting on the lesson surface
 * (so they don't construct a real EngineClient and lazily connect to
 * a daemon socket).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverActivePacks } from '../packs/discovery.js';
import { sortPacksByScope } from '../packs/load_order.js';

import { buildRegistry, buildValidationRegistry } from './bootstrap.js';

import type { RagBackend } from '../rag/types.js';
import type { WedgeLessonStore } from '../rag/wedge/store.js';

function stubBackend(): RagBackend {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: () => Promise.resolve(),
    deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
  };
}

describe('buildValidationRegistry (PV.1) — names-complete, no I/O', () => {
  it('registers the FULL name set incl. RAG + lesson names (no lessonStore:null drop)', async () => {
    const registry = await buildValidationRegistry();
    // RAG names (need a backend) AND lesson names (need a non-null lessonStore) must BOTH be present,
    // or validatePackFunctions false-fails a pack that calls them. This is the no-false-positive guard.
    expect(registry.has('recall')).toBe(true);
    expect(registry.has('embed')).toBe(true);
    expect(registry.has('promote_lesson')).toBe(true);
    expect(registry.has('propose_lesson')).toBe(true);
    expect(registry.has('verdict')).toBe(true);
  });
});

describe('buildRegistry — T.3 RAG wiring', () => {
  it('registers recall, embed, store_lesson primitives', async () => {
    const registry = await buildRegistry({ backend: stubBackend(), lessonStore: null });
    expect(registry.has('recall')).toBe(true);
    expect(registry.has('embed')).toBe(true);
    expect(registry.has('store_lesson')).toBe(true);
  });

  it('still registers all pre-T.3 primitive families', async () => {
    const registry = await buildRegistry({ backend: stubBackend(), lessonStore: null });
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
      deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
    };
    await buildRegistry({ backend, lessonStore: null });
    expect(initCalled).toBe(true);
  });
});

describe('buildRegistry — T.6 lesson wiring (wedge gate surface)', () => {
  // The wedge gate firing is the entire competitive moat. These
  // assertions guard the *registration* surface (not the gate firing
  // itself — that's the E2E in test/e2e/wedge_gate.test.ts).
  it('registers the lesson primitives when a store is injected', async () => {
    // A minimal stub store — buildRegistry only calls init() before registering;
    // no primitive is invoked here, so the other methods are never touched.
    const store = { init: () => Promise.resolve() } as unknown as WedgeLessonStore;
    const registry = await buildRegistry({ backend: stubBackend(), lessonStore: store });
    expect(registry.has('propose_lesson')).toBe(true);
    expect(registry.has('promote_lesson')).toBe(true);
    expect(registry.has('recall_lesson')).toBe(true);
    expect(registry.has('capture_feedback')).toBe(true);
    expect(registry.has('record_applied')).toBe(true);
  });

  it('skips lesson registration when lessonStore is null', async () => {
    const registry = await buildRegistry({ backend: stubBackend(), lessonStore: null });
    expect(registry.has('propose_lesson')).toBe(false);
    expect(registry.has('promote_lesson')).toBe(false);
    expect(registry.has('recall_lesson')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G.1 — active-pack discovery + scope composition.
//
// The "real" path in `bootstrap.ts:realPacksPromise` is captured at
// module-load time, which makes it hard to exercise every branch from a
// single test process. We test the COMPOSITION LOGIC (the building blocks
// `discoverActivePacks` + `sortPacksByScope`) directly here — that's where
// the actual ordering invariants live. Subprocess integration tests
// (`hooks.integration.test.ts` + `test/e2e/runtime-smoke.test.ts`) cover
// the live module-load path.
// ---------------------------------------------------------------------------

describe('G.1 bootstrap composition — discoverActivePacks + sortPacksByScope', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'opensquid-bootstrap-compose-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makePackAt(scopeRoot: string, name: string, scope: string): Promise<void> {
    const packDir = join(scopeRoot, 'packs', name);
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, 'manifest.yaml'),
      [`name: ${name}`, 'version: 0.1.0', `scope: ${scope}`, 'goal: t'].join('\n') + '\n',
      'utf8',
    );
  }

  async function makeScope(scopeName: string, packs: { name: string; scope: string }[]) {
    const scopeRoot = join(root, scopeName);
    await mkdir(scopeRoot, { recursive: true });
    for (const p of packs) await makePackAt(scopeRoot, p.name, p.scope);
    await writeFile(
      join(scopeRoot, 'active.json'),
      JSON.stringify({ packs: packs.map((p) => p.name) }),
      'utf8',
    );
    return scopeRoot;
  }

  it('composes user-scope packs [A, B] + project-scope packs [C] sorted by scope tier then name', async () => {
    // User scope ships two packs at different scope tiers; project scope
    // ships one. The composed list (post-sort) should land in:
    //   universal (a) → workflow (b) → project (c).
    const userRoot = await makeScope('user', [
      { name: 'b-workflow', scope: 'workflow' },
      { name: 'a-universal', scope: 'universal' },
    ]);
    const projRoot = await makeScope('project', [{ name: 'c-project', scope: 'project' }]);

    const user = await discoverActivePacks(userRoot);
    const proj = await discoverActivePacks(projRoot);
    const composed = sortPacksByScope([...user, ...proj]);

    expect(composed.map((p) => p.name)).toEqual(['a-universal', 'b-workflow', 'c-project']);
  });

  it('alphabetical tie-break within scope tier', async () => {
    const userRoot = await makeScope('user', [
      { name: 'charlie', scope: 'workflow' },
      { name: 'alpha', scope: 'workflow' },
      { name: 'bravo', scope: 'workflow' },
    ]);

    const user = await discoverActivePacks(userRoot);
    const composed = sortPacksByScope(user);

    expect(composed.map((p) => p.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('null project-scope root contributes nothing', async () => {
    const userRoot = await makeScope('user', [{ name: 'only-one', scope: 'workflow' }]);
    const user = await discoverActivePacks(userRoot);
    const proj = await discoverActivePacks(null);
    const composed = sortPacksByScope([...user, ...proj]);

    expect(composed.map((p) => p.name)).toEqual(['only-one']);
  });
});

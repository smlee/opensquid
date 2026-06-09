/**
 * Memory scope isolation (T-memory-scope-isolation) — the regression-lock suite.
 *
 * Two layers, both required by the design:
 *  1. `inScope` pure-predicate unit table — the one place the cross/isolate rule lives.
 *  2. backend isolation over a real libSQL store — a recall scoped to umbrella A returns A's project
 *     rows + every shared row and EXCLUDES B's; a null scope returns shared only; two cwds in the same
 *     umbrella share a namespace (the umbrella-collapse). This test FAILS the instant cross-project
 *     leak returns — the regression firewall.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { libsqlStoreBackend } from './backends/libsql_store.js';
import { inScope } from './types.js';

import type { Embedder } from './embedders/types.js';
import type { Lesson } from './types.js';

const fakeEmbedder: Embedder = { dim: 4, embed: (t) => Promise.resolve([t.length % 5, 1, 0, 0]) };

const mem = (over: Partial<Lesson>): Lesson => ({
  id: 'x',
  content: 'needle',
  tags: [],
  source: 'memory',
  author: 'user',
  createdAt: '2026-06-09T00:00:00.000Z',
  ...over,
});

describe('inScope (pure predicate)', () => {
  it('shared crosses every scope (incl. null namespace)', () => {
    expect(inScope('shared', null, { namespace: 'A' })).toBe(true);
    expect(inScope('shared', null, { namespace: null })).toBe(true);
    expect(inScope(undefined, null, { namespace: 'A' })).toBe(true); // absent tier ⇒ shared
  });
  it('project matches only its own namespace', () => {
    expect(inScope('project', 'A', { namespace: 'A' })).toBe(true);
    expect(inScope('project', 'A', { namespace: 'B' })).toBe(false);
  });
  it('project with a null recall namespace is withheld (fail-closed)', () => {
    expect(inScope('project', 'A', { namespace: null })).toBe(false);
  });
  it('project with a null memory namespace never matches', () => {
    expect(inScope('project', null, { namespace: 'A' })).toBe(false);
    expect(inScope('project', null, { namespace: null })).toBe(false);
  });
});

describe('libsql store scope isolation (the regression firewall)', () => {
  let dir: string;
  let dbUrl: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scope-'));
    dbUrl = `file:${join(dir, 's.db')}`;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('recall scoped to umbrella A returns A + shared, EXCLUDES B', async () => {
    const b = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await b.init();
    await b.storeLesson(mem({ id: 'sh', tier: 'shared', namespace: null }));
    await b.storeLesson(mem({ id: 'pa', tier: 'project', namespace: 'umbrella-A' }));
    await b.storeLesson(mem({ id: 'pb', tier: 'project', namespace: 'umbrella-B' }));

    const ids = (await b.recall('needle', 10, { namespace: 'umbrella-A' })).map((h) => h.lesson.id);
    expect(ids).toContain('sh'); // shared crosses
    expect(ids).toContain('pa'); // A's project memory in A's scope
    expect(ids).not.toContain('pb'); // B's project memory NEVER leaks into A
  });

  it('a null scope returns shared only — never leaks any project memory', async () => {
    const b = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await b.init();
    await b.storeLesson(mem({ id: 'sh', tier: 'shared', namespace: null }));
    await b.storeLesson(mem({ id: 'pa', tier: 'project', namespace: 'umbrella-A' }));

    const ids = (await b.recall('needle', 10, { namespace: null })).map((h) => h.lesson.id);
    expect(ids).toEqual(['sh']);
  });

  it('umbrella-collapse: two cwds in the same umbrella share a namespace', async () => {
    // loop + opensquid resolve to the SAME umbrella id → a memory written under one is recallable
    // from the other (this is why the namespace key is the umbrella, not the raw project UUID).
    const b = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await b.init();
    await b.storeLesson(mem({ id: 'loop-mem', tier: 'project', namespace: 'loop' }));
    const ids = (await b.recall('needle', 10, { namespace: 'loop' })).map((h) => h.lesson.id);
    expect(ids).toContain('loop-mem');
  });
});

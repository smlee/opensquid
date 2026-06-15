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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProjectMarker } from '../runtime/paths.js';

import { libsqlStoreBackend } from './backends/libsql_store.js';
import { resolveRecallScope } from './scope.js';
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

  it('a project row is recallable only under its own namespace (per-repo, UCC.1)', async () => {
    // De-umbrella'd: the namespace key is the per-repo project UUID, NOT a chat umbrella id.
    const b = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await b.init();
    await b.storeLesson(mem({ id: 'proj-mem', tier: 'project', namespace: 'uuid-X' }));
    expect(
      (await b.recall('needle', 10, { namespace: 'uuid-X' })).map((h) => h.lesson.id),
    ).toContain('proj-mem');
    expect(
      (await b.recall('needle', 10, { namespace: 'uuid-Y' })).map((h) => h.lesson.id),
    ).not.toContain('proj-mem');
  });
});

describe('resolveRecallScope — per-repo marker resolution (UCC.1 de-umbrella)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marker-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeMarker = async (at: string, uuid: string): Promise<void> => {
    await mkdir(join(at, '.opensquid'), { recursive: true });
    await writeFile(
      join(at, '.opensquid', 'project.json'),
      JSON.stringify({ version: 1, id: uuid, uuid }),
      'utf8',
    );
  };

  it('nested markers resolve PER-REPO: a sub-repo cwd → its own UUID, not the parent', async () => {
    await writeMarker(dir, 'uuid-parent');
    const sub = join(dir, 'sub');
    await writeMarker(sub, 'uuid-sub');
    expect(await resolveProjectMarker(sub)).toEqual({ root: sub, uuid: 'uuid-sub' });
    expect(await resolveRecallScope(sub)).toEqual({ namespace: 'uuid-sub' });
    // and the parent still resolves to itself
    expect(await resolveRecallScope(dir)).toEqual({ namespace: 'uuid-parent' });
  });

  it('a fully markerless cwd → null marker → env-or-null namespace', async () => {
    const prev = process.env.OPENSQUID_PROJECT_UUID;
    delete process.env.OPENSQUID_PROJECT_UUID;
    try {
      expect(await resolveProjectMarker(dir)).toBeNull();
      expect(await resolveRecallScope(dir)).toEqual({ namespace: null });
    } finally {
      if (prev !== undefined) process.env.OPENSQUID_PROJECT_UUID = prev;
    }
  });

  it('NO-DIVERGENCE: a `.opensquid/` dir WITHOUT project.json → null (the (A)-over-(D) guarantee)', async () => {
    // The divergence-critical path: an .opensquid/ DIRECTORY exists but has no project.json.
    // resolveProjectMarker keeps walking (readFile ENOENT) → null, so recall fails closed. The SAME
    // resolver feeds handoff (UCC.2), so both process-scope surfaces fall back identically — neither
    // ever resolves to the bare .opensquid/ dir. This is exactly the case (D) would have diverged on.
    await mkdir(join(dir, '.opensquid'), { recursive: true }); // dir but NO project.json
    const prev = process.env.OPENSQUID_PROJECT_UUID;
    delete process.env.OPENSQUID_PROJECT_UUID;
    try {
      expect(await resolveProjectMarker(dir)).toBeNull();
      expect(await resolveRecallScope(dir)).toEqual({ namespace: null });
    } finally {
      if (prev !== undefined) process.env.OPENSQUID_PROJECT_UUID = prev;
    }
  });
});

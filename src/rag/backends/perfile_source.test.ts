/**
 * Tests for the per-file source layer (T-STORE-PERFILE-SOURCE): round-trip fidelity (incl. a
 * body containing `---` and colons, proving the body never re-enters YAML), atomic/fenced write,
 * unsafe-id rejection, missing-dir → [], and the libsql_store integration (storeLesson writes the
 * file + is recallable; rebuildLibsqlIndex reconstructs the index from the source). A deterministic
 * fake Embedder keeps it offline + fast.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { libsqlStoreBackend, rebuildLibsqlIndex } from './libsql_store.js';
import { readRecords, writeRecord } from './perfile_source.js';

import { UserAuthoredImmunityError } from '../types.js';

import type { Embedder } from '../embedders/types.js';
import type { Lesson } from '../types.js';

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'lesson-abc123',
  content: 'hello world',
  tags: ['a', 'b'],
  source: 'test',
  author: 'user',
  createdAt: '2026-06-07T00:00:00.000Z',
  ...over,
});

const fakeEmbedder: Embedder = { dim: 4, embed: (t) => Promise.resolve([t.length % 5, 1, 0, 0]) };

describe('perfile_source', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pfs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a lesson, incl. a body containing --- and colons', async () => {
    const l = lesson({ content: 'line1\n---\nnot: frontmatter: value\n## heading' });
    await writeRecord(dir, l);
    const [got] = await readRecords(dir);
    expect(got).toEqual(l);
  });

  it('round-trips retired_at (non-default-only) so a rebuild preserves demotion (wg-9e4f4eb2a40f)', async () => {
    await writeRecord(dir, lesson({ id: 'r', retired_at: '2026-06-12T00:00:00.000Z' }));
    await writeRecord(dir, lesson({ id: 'live' })); // no retired_at
    const got = await readRecords(dir);
    expect(got.find((l) => l.id === 'r')?.retired_at).toBe('2026-06-12T00:00:00.000Z');
    expect(got.find((l) => l.id === 'live')).not.toHaveProperty('retired_at');
  });

  it('writes the standard ---fenced form and no .tmp lingers', async () => {
    await writeRecord(dir, lesson());
    const raw = await readFile(join(dir, 'lesson-abc123.md'), 'utf8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(await readRecords(dir)).toHaveLength(1); // only the .md, not a .tmp
  });

  it('rejects an unsafe id (path traversal)', async () => {
    await expect(writeRecord(dir, lesson({ id: '../escape' }))).rejects.toThrow(/unsafe/);
  });

  it('missing dir → []', async () => {
    expect(await readRecords(join(dir, 'nope'))).toEqual([]);
  });

  it('round-trips the compression keys when non-default; base lesson stays key-free', async () => {
    const mc = lesson({ id: 'mc-1', derivedFrom: ['mem-a', 'mem-b'], consumedByUserLessons: 4 });
    await writeRecord(dir, mc);
    const [got] = await readRecords(dir);
    expect(got).toEqual(mc); // derivedFrom + consumedByUserLessons survive
    // a base lesson (no compression keys) writes a file WITHOUT those keys → round-trips key-free
    await writeRecord(dir, lesson({ id: 'base-1' }));
    const baseRaw = await readFile(join(dir, 'base-1.md'), 'utf8');
    expect(baseRaw).not.toContain('derived_from');
    expect(baseRaw).not.toContain('consumed_by_user_lessons');
  });
});

describe('libsql store: per-file source + rebuild', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pfs-db-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('storeLesson with sourceDir writes the file AND the row is recallable', async () => {
    const backend = libsqlStoreBackend({
      dbUrl: ':memory:',
      embedder: fakeEmbedder,
      sourceDir: dir,
    });
    await backend.init();
    await backend.storeLesson(lesson({ content: 'the unique needle phrase' }));
    expect(await readRecords(dir)).toHaveLength(1);
    const hits = await backend.recall('needle', 5, { namespace: null });
    expect(hits.some((h) => h.lesson.id === 'lesson-abc123')).toBe(true);
  });

  it('rebuildLibsqlIndex reconstructs the index from the source files', async () => {
    await writeRecord(dir, lesson({ id: 'r1', content: 'alpha needle' }));
    await writeRecord(dir, lesson({ id: 'r2', content: 'beta haystack' }));
    const dbUrl = `file:${join(dir, 'idx.db')}`;
    const n = await rebuildLibsqlIndex({ dbUrl, embedder: fakeEmbedder, sourceDir: dir });
    expect(n).toBe(2);
    const backend = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await backend.init();
    const hits = await backend.recall('needle', 5, { namespace: null });
    expect(hits.some((h) => h.lesson.id === 'r1')).toBe(true);
  });

  it('rebuild keeps a consolidated memory (Mc) AND its derived_from trace (the HIGH bug)', async () => {
    // An Mc with a per-file source carrying derived_from (what insertMemory(sourceDir) now writes).
    await writeRecord(
      dir,
      lesson({
        id: 'mc-x',
        content: 'compressed needle gist',
        derivedFrom: ['mem-a', 'mem-b'],
        consumedByUserLessons: 4, // user-immunity counter — must survive the rebuild too
      }),
    );
    const dbUrl = `file:${join(dir, 'idx.db')}`;
    await rebuildLibsqlIndex({ dbUrl, embedder: fakeEmbedder, sourceDir: dir });
    const backend = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await backend.init();
    const hit = (await backend.recall('needle', 5, { namespace: null })).find(
      (h) => h.lesson.id === 'mc-x',
    );
    expect(hit).toBeDefined(); // Mc survived the rebuild (was lost before the fix)
    expect(hit?.lesson.content).toBe('compressed needle gist');
    expect(hit?.lesson.derivedFrom).toEqual(['mem-a', 'mem-b']); // the compression trace survived too
    expect(hit?.lesson.consumedByUserLessons).toBe(4); // immunity counter preserved across rebuild
  });
});

describe('libsql store: deleteLesson (explicit-only, user-immune)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pfs-del-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const mk = () =>
    libsqlStoreBackend({
      dbUrl: `file:${join(dir, 'd.db')}`,
      embedder: fakeEmbedder,
      sourceDir: dir,
    });

  it('deletes an agent lesson (no force) — DB row + per-file both gone', async () => {
    const backend = mk();
    await backend.init();
    await backend.storeLesson(lesson({ id: 'a1', author: 'agent', content: 'needle one' }));
    expect(await backend.deleteLesson('a1')).toEqual({ deleted: true, forced: false });
    expect(
      (await backend.recall('needle', 5, { namespace: null })).some((h) => h.lesson.id === 'a1'),
    ).toBe(false);
    expect((await readRecords(dir)).some((l) => l.id === 'a1')).toBe(false);
  });

  it('a user-authored lesson is immune without force (and survives)', async () => {
    const backend = mk();
    await backend.init();
    await backend.storeLesson(lesson({ id: 'u1', author: 'user' }));
    await expect(backend.deleteLesson('u1')).rejects.toBeInstanceOf(UserAuthoredImmunityError);
    expect((await readRecords(dir)).some((l) => l.id === 'u1')).toBe(true);
  });

  it('force deletes a user-authored lesson (forced:true)', async () => {
    const backend = mk();
    await backend.init();
    await backend.storeLesson(lesson({ id: 'u2', author: 'user' }));
    expect(await backend.deleteLesson('u2', { force: true })).toEqual({
      deleted: true,
      forced: true,
    });
  });

  it('a not-found id → { deleted: false }', async () => {
    const backend = mk();
    await backend.init();
    expect(await backend.deleteLesson('nope')).toEqual({ deleted: false, forced: false });
  });
});

describe('libsql store: retention sweep + re-promote (RSW.1, wg-9e4f4eb2a40f)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pfs-rsw-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const mk = () =>
    libsqlStoreBackend({
      dbUrl: `file:${join(dir, 'r.db')}`,
      embedder: fakeEmbedder,
      sourceDir: dir,
    });

  const CUTOFF = '2026-06-10T00:00:00.000Z';
  const OLD = '2026-06-01T00:00:00.000Z'; // before cutoff
  const RECENT = '2026-06-14T00:00:00.000Z'; // after cutoff

  it('sweepRetired deletes only aged non-immune AGENT rows; user/cited/recent/live kept', async () => {
    const backend = mk();
    await backend.init();
    await backend.storeLesson(lesson({ id: 'agent-old', author: 'agent', retired_at: OLD }));
    await backend.storeLesson(lesson({ id: 'agent-recent', author: 'agent', retired_at: RECENT }));
    await backend.storeLesson(lesson({ id: 'agent-live', author: 'agent' })); // not retired
    await backend.storeLesson(lesson({ id: 'user-old', author: 'user', retired_at: OLD }));
    await backend.storeLesson(
      lesson({ id: 'cited-old', author: 'agent', retired_at: OLD, consumedByUserLessons: 3 }),
    );

    const deleted = await backend.sweepRetired!(CUTOFF);
    expect(deleted).toEqual(['agent-old']);
    const ids = (await readRecords(dir)).map((l) => l.id).sort();
    expect(ids).toEqual(['agent-live', 'agent-recent', 'cited-old', 'user-old']); // agent-old gone
  });

  it('repromoteRetiredUserMemories clears retired_at on user rows (per-file too), idempotent; agents untouched', async () => {
    const backend = mk();
    await backend.init();
    await backend.storeLesson(lesson({ id: 'u-demoted', author: 'user', retired_at: OLD }));
    await backend.storeLesson(lesson({ id: 'a-demoted', author: 'agent', retired_at: OLD }));

    const restored = await backend.repromoteRetiredUserMemories!();
    expect(restored).toEqual(['u-demoted']);
    // per-file source dropped retired_at → a rebuild keeps it live
    expect(
      await readRecords(dir).then((rs) => rs.find((l) => l.id === 'u-demoted')),
    ).not.toHaveProperty('retired_at');
    // agent retired row untouched
    expect((await readRecords(dir)).find((l) => l.id === 'a-demoted')?.retired_at).toBe(OLD);
    // idempotent
    expect(await backend.repromoteRetiredUserMemories!()).toEqual([]);
  });
});

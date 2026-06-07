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
    const hits = await backend.recall('needle', 5);
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
    const hits = await backend.recall('needle', 5);
    expect(hits.some((h) => h.lesson.id === 'r1')).toBe(true);
  });
});

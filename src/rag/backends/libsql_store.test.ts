/**
 * Tests for `storeLesson`'s no-op short-circuit (always-on ingest re-stores the whole transcript every
 * Stop; an unchanged, already-embedded row must NOT pay a re-embed/rewrite). A counting fake embedder
 * makes the embed cost observable; correctness guards (demote not skipped; null-embedding backfilled) are
 * asserted explicitly.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { libsqlStoreBackend } from './libsql_store.js';

import type { Embedder } from '../embedders/types.js';
import type { Lesson, RagBackend } from '../types.js';

const lesson = (over: Partial<Lesson> = {}): Lesson => ({
  id: 'l1',
  content: 'hello world',
  tags: ['a'],
  source: 'test',
  author: 'agent',
  createdAt: '2026-06-24T00:00:00.000Z',
  tier: 'shared',
  namespace: null,
  durability: 'durable',
  ...over,
});

describe('libsqlStoreBackend.storeLesson — no-op short-circuit', () => {
  let dir: string;
  let backend: RagBackend;
  let embedCalls: number;
  let embedRet: number[] | null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lsb-'));
    embedCalls = 0;
    embedRet = [1, 0, 0, 0];
    const embedder: Embedder = {
      dim: 4,
      embed: () => {
        embedCalls++;
        return Promise.resolve(embedRet);
      },
    };
    backend = libsqlStoreBackend({ dbUrl: `file:${join(dir, 'x.db')}`, embedder });
    await backend.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips the re-embed when an identical, already-embedded row is re-stored', async () => {
    await backend.storeLesson(lesson());
    expect(embedCalls).toBe(1);
    await backend.storeLesson(lesson()); // byte-identical
    expect(embedCalls).toBe(1); // short-circuited — no second embed
  });

  it('re-embeds when the content changes', async () => {
    await backend.storeLesson(lesson());
    await backend.storeLesson(lesson({ content: 'different body' }));
    expect(embedCalls).toBe(2);
  });

  it('does NOT skip a demote (unchanged content, new retired_at) — the row is actually retired', async () => {
    await backend.storeLesson(lesson());
    expect(await backend.recall('hello world', 5, { namespace: null })).toHaveLength(1);
    await backend.storeLesson(lesson({ retired_at: '2026-06-24T01:00:00.000Z' })); // same content, now retired
    expect(await backend.recall('hello world', 5, { namespace: null })).toHaveLength(0); // retired ⇒ excluded
  });

  it('re-embeds a row whose stored embedding is null (backfill after embedder recovery)', async () => {
    embedRet = null; // embedder "down"
    await backend.storeLesson(lesson());
    expect(embedCalls).toBe(1);
    embedRet = [1, 0, 0, 0]; // recovered
    await backend.storeLesson(lesson()); // identical content, but the prior row has no embedding
    expect(embedCalls).toBe(2); // NOT skipped — the null embedding is backfilled
  });
});

/**
 * Tests for the memory-compression store accessors (retire-Rust RES-4a): the additive
 * `ensureCompressionColumns` migration + getMemoryById + insertMemory, against a tmp libSQL DB.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureCompressionColumns,
  getMemoryById,
  insertMemory,
  listMemories,
  updateMemory,
  IMPORT_TAG_PREFIX,
} from './store.js';
import type { MemoryRow } from './compress.js';

let dir: string;
let client: Client;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mem-store-'));
  client = createClient({ url: `file:${join(dir, 'm.db')}` });
  // The OLD-shape lessons table (no compression columns) — as the base libsql_store creates it.
  await client.execute(`CREATE TABLE lessons (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, tags TEXT NOT NULL, source TEXT NOT NULL,
    author TEXT NOT NULL, created_at TEXT NOT NULL, embedding F32_BLOB(8)
  );`);
  await client.execute(
    `CREATE VIRTUAL TABLE lessons_fts USING fts5(id UNINDEXED, content, tags, source);`,
  );
});
afterEach(async () => {
  client.close();
  await rm(dir, { recursive: true, force: true });
});

describe('memory-compression store', () => {
  it('ensureCompressionColumns is additive + idempotent; old rows read with defaults', async () => {
    // An old-shape row written BEFORE the columns exist.
    await client.execute({
      sql: `INSERT INTO lessons (id, content, tags, source, author, created_at) VALUES (?,?,?,?,?,?)`,
      args: ['mem-old', 'legacy body', '["scope:user"]', 'memory', 'user', '2026-05-01T00:00:00Z'],
    });
    await ensureCompressionColumns(client);
    await ensureCompressionColumns(client); // idempotent — must not throw on the duplicate ALTER

    const old = await getMemoryById(client, 'mem-old');
    expect(old).not.toBeNull();
    expect(old?.derivedFrom).toEqual([]); // defaulted
    expect(old?.consumedByUserLessons).toBe(0); // defaulted
    expect(old?.content).toBe('legacy body');
    expect(old?.author).toBe('user');
  });

  it('insertMemory round-trips the compression columns', async () => {
    await ensureCompressionColumns(client);
    const mc: MemoryRow = {
      id: 'mem-c-abc',
      content: 'compressed gist',
      tags: ['scope:user'],
      source: 'memory',
      author: 'agent',
      createdAt: '2026-06-08T00:00:00Z',
      derivedFrom: ['mem-a', 'mem-b'],
      consumedByUserLessons: 8,
    };
    await insertMemory(client, mc);
    const got = await getMemoryById(client, 'mem-c-abc');
    expect(got?.derivedFrom).toEqual(['mem-a', 'mem-b']);
    expect(got?.consumedByUserLessons).toBe(8);
    expect(got?.tags).toEqual(['scope:user']);
    expect(got?.content).toBe('compressed gist');
  });

  it('getMemoryById returns null for a missing id', async () => {
    await ensureCompressionColumns(client);
    expect(await getMemoryById(client, 'nope')).toBeNull();
  });

  function memRow(id: string, over: Partial<MemoryRow> = {}): MemoryRow {
    return {
      id,
      content: `content ${id}`,
      tags: ['scope:user'],
      source: 'memory',
      author: 'agent',
      createdAt: `2026-05-${id.slice(-2)}T00:00:00Z`,
      derivedFrom: [],
      consumedByUserLessons: 0,
      ...over,
    };
  }

  it('listMemories pages deterministically with no dup/gap + carries tags + total', async () => {
    await ensureCompressionColumns(client);
    const ids = ['mem-01', 'mem-02', 'mem-03', 'mem-04', 'mem-05'];
    for (const id of ids) {
      await insertMemory(client, memRow(id, { tags: ['scope:user', `${IMPORT_TAG_PREFIX}${id}`] }));
    }
    const p1 = await listMemories(client, { limit: 2, offset: 0 });
    const p2 = await listMemories(client, { limit: 2, offset: 2 });
    const p3 = await listMemories(client, { limit: 2, offset: 4 });
    expect(p1.total).toBe(5);
    expect(p1.returned).toBe(2);
    expect(p3.returned).toBe(1);
    const seen = [...p1.results, ...p2.results, ...p3.results].map((r) => r.id);
    expect(seen.sort()).toEqual(ids); // every row once, no gap/dup
    // the import marker tag round-trips insert→list
    expect(p1.results[0]!.tags).toContain(`${IMPORT_TAG_PREFIX}mem-01`);
  });

  it('updateMemory replaces content + scope tag + re-embeds, preserving marker + derivedFrom', async () => {
    await ensureCompressionColumns(client);
    await insertMemory(
      client,
      memRow('mem-u', {
        tags: ['scope:user', `${IMPORT_TAG_PREFIX}note`],
        derivedFrom: ['mem-x'],
        content: 'old content',
      }),
    );
    let embedCalls = 0;
    const embed = (_t: string): Promise<number[] | null> => {
      embedCalls += 1;
      return Promise.resolve([0.5]);
    };
    await updateMemory(client, embed, {
      id: 'mem-u',
      content: 'new folded content',
      scope: 'team',
    });
    const got = await getMemoryById(client, 'mem-u');
    expect(got?.content).toBe('new folded content');
    expect(got?.tags).toContain('scope:team'); // scope replaced
    expect(got?.tags).not.toContain('scope:user');
    expect(got?.tags).toContain(`${IMPORT_TAG_PREFIX}note`); // marker preserved
    expect(got?.derivedFrom).toEqual(['mem-x']); // derived_from preserved
    expect(embedCalls).toBe(1); // re-embedded
  });

  it('updateMemory throws for a missing id', async () => {
    await ensureCompressionColumns(client);
    await expect(
      updateMemory(client, () => Promise.resolve(null), { id: 'ghost', content: 'x' }),
    ).rejects.toThrow(/not found/);
  });
});

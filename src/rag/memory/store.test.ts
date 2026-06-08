/**
 * Tests for the memory-compression store accessors (retire-Rust RES-4a): the additive
 * `ensureCompressionColumns` migration + getMemoryById + insertMemory, against a tmp libSQL DB.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCompressionColumns, getMemoryById, insertMemory } from './store.js';
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
});

/**
 * Tests for the engine→libSQL memory migration (T-MIGRATE-MEMORIES). Runs on FIXTURE memories in a
 * temp dir (never the user's real ~/.opensquid/memories). Uses a file dbUrl (rebuildLibsqlIndex
 * opens its own libSQL client) + a deterministic stub embedder, mirroring perfile_source.test.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { libsqlStoreBackend } from './backends/libsql_store.js';
import type { Embedder } from './embedders/types.js';
import { migrateMemories, parseMemoryFile } from './migrate_memories.js';

const fakeEmbedder: Embedder = { dim: 4, embed: (t) => Promise.resolve([t.length % 5, 1, 0, 0]) };

const MEM_A = `---
id: mem-aaa111
description: how to deploy the squid
created_at: '2026-01-01T00:00:00Z'
scope: project
origin:
  host: mac
  session_id: s1
---
Run the deploy script after gates pass.`;

const MEM_B = `---
id: mem-bbb222
description: prefer pnpm over npm
created_at: '2026-02-02T00:00:00Z'
scope: user
origin:
  host: mac
---
Never run npm i in this repo.`;

describe('parseMemoryFile', () => {
  it('maps id/description+body/created_at + scope→tag; ignores nested origin', () => {
    const l = parseMemoryFile(MEM_A, 'fallback');
    expect(l.id).toBe('mem-aaa111');
    expect(l.content).toContain('how to deploy the squid');
    expect(l.content).toContain('Run the deploy script');
    expect(l.tags).toEqual(['scope:project']);
    expect(l.source).toBe('memory');
    expect(l.author).toBe('user');
    expect(l.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('falls back on a missing id; empty tags when no scope', () => {
    const l = parseMemoryFile('no frontmatter here', 'mem-fallback');
    expect(l.id).toBe('mem-fallback');
    expect(l.tags).toEqual([]);
  });
});

describe('migrateMemories', () => {
  let memDir: string;
  let sourceDir: string;
  let dbDir: string;
  beforeEach(async () => {
    memDir = await mkdtemp(join(tmpdir(), 'mem-'));
    sourceDir = await mkdtemp(join(tmpdir(), 'src-'));
    dbDir = await mkdtemp(join(tmpdir(), 'db-'));
    await writeFile(join(memDir, 'mem-aaa111.md'), MEM_A);
    await writeFile(join(memDir, 'mem-bbb222.md'), MEM_B);
    await writeFile(join(memDir, 'not-a-memory.txt'), 'ignored');
  });
  afterEach(async () => {
    await rm(memDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  it('migrates mem-*.md into the libSQL store; recall finds them (.txt skipped)', async () => {
    const dbUrl = `file:${join(dbDir, 'store.db')}`;
    const { migrated } = await migrateMemories({
      memDir,
      sourceDir,
      dbUrl,
      embedder: fakeEmbedder,
    });
    expect(migrated).toBe(2);
    const backend = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await backend.init();
    const hits = await backend.recall('pnpm npm', 5);
    expect(hits.some((h) => h.lesson.id === 'mem-bbb222')).toBe(true);
  });

  it('is idempotent on re-run', async () => {
    const dbUrl = `file:${join(dbDir, 'store2.db')}`;
    await migrateMemories({ memDir, sourceDir, dbUrl, embedder: fakeEmbedder });
    const { migrated } = await migrateMemories({
      memDir,
      sourceDir,
      dbUrl,
      embedder: fakeEmbedder,
    });
    expect(migrated).toBe(2);
    const backend = libsqlStoreBackend({ dbUrl, embedder: fakeEmbedder });
    await backend.init();
    const hits = await backend.recall('deploy squid', 5);
    expect(hits.some((h) => h.lesson.id === 'mem-aaa111')).toBe(true);
  });
});

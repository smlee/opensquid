/**
 * Unit tests for `importAutoMemoryDir` + `fetchExistingImportIndex` + `pruneOrphanedImports`
 * (retire-Rust RES-5b). Real tmp dirs for the fixture files (the reader needs real I/O); the
 * `MemoryStore` is stubbed so we assert orchestration only: scope mapping, create / refresh / skip
 * reconciliation (on the FOLDED content — libSQL memory is content-only), dry-run no-op, MEMORY.md
 * skip, whitelist filter, error isolation, prune.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchExistingImportIndex,
  importAutoMemoryDir,
  pruneOrphanedImports,
  type ImportIndexEntry,
} from './auto_memory_importer.js';
import { folded, type MemoryStore } from './memory_store_handle.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-importer-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(name: string, type: 'user' | 'feedback' | 'project' | 'reference'): string {
  return `---
name: ${name}
description: "desc-${name}"
metadata:
  type: ${type}
---
body of ${name}
`;
}

/** The FOLDED content the store holds for `fixture(name, …)` = `desc-<name>\n\nbody of <name>`. */
function fixtureFolded(name: string): string {
  return folded(`desc-${name}`, `body of ${name}`);
}

async function write(file: string, contents: string): Promise<void> {
  await fs.writeFile(join(dir, file), contents, 'utf-8');
}

interface Stub {
  store: MemoryStore;
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

/** Stub MemoryStore. `storedContent` maps id → the FOLDED content `get` returns (refresh-vs-skip). */
function mkStore(storedContent: Record<string, string> = {}): Stub {
  let n = 0;
  const create = vi.fn().mockImplementation(() => Promise.resolve({ id: `mem-new-${n++}` }));
  const get = vi
    .fn()
    .mockImplementation((id: string) =>
      Promise.resolve(storedContent[id] !== undefined ? { content: storedContent[id] } : null),
    );
  const update = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn().mockResolvedValue(undefined);
  const store = {
    create,
    get,
    update,
    delete: del,
    listImportIndex: vi.fn().mockResolvedValue(new Map()),
    close: () => Promise.resolve(),
  } as unknown as MemoryStore;
  return { store, create, get, update, del };
}

function idx(entries: Record<string, string>): Map<string, ImportIndexEntry> {
  return new Map(Object.entries(entries).map(([name, id]) => [name, { id }]));
}

describe('importAutoMemoryDir', () => {
  it('imports all .md files when none exist; no errors', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    await write('c.md', fixture('c', 'project'));
    const { store, create } = mkStore();
    const result = await importAutoMemoryDir(dir, store, { dryRun: false, existingIndex: idx({}) });
    expect(result).toEqual({ imported: 3, refreshed: 0, skipped: 0, errors: [] });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('skips an existing entry whose folded content is unchanged', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    const { store, create, get, update } = mkStore({ 'id-a': fixtureFolded('a') });
    const result = await importAutoMemoryDir(dir, store, {
      dryRun: false,
      existingIndex: idx({ a: 'id-a' }),
    });
    expect(result).toEqual({ imported: 1, refreshed: 0, skipped: 1, errors: [] });
    expect(create).toHaveBeenCalledTimes(1); // only b (new)
    expect(get).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect((create.mock.calls[0]?.[0] as { description: string }).description).toBe('desc-b');
  });

  it('refreshes when the DESCRIPTION changed (folded content differs)', async () => {
    await write('a.md', fixture('a', 'feedback')); // disk desc = 'desc-a'
    const { store, update } = mkStore({ 'id-a': folded('STALE desc', 'body of a') });
    const result = await importAutoMemoryDir(dir, store, {
      dryRun: false,
      existingIndex: idx({ a: 'id-a' }),
    });
    expect(result).toEqual({ imported: 0, refreshed: 1, skipped: 0, errors: [] });
    expect((update.mock.calls[0]?.[1] as { description: string }).description).toBe('desc-a');
  });

  it('refreshes when the body changed (store.update, not create)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { store, create, update } = mkStore({ 'id-a': folded('desc-a', 'OLD body of a') });
    const result = await importAutoMemoryDir(dir, store, {
      dryRun: false,
      existingIndex: idx({ a: 'id-a' }),
    });
    expect(result).toEqual({ imported: 0, refreshed: 1, skipped: 0, errors: [] });
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const [id, arg] = update.mock.calls[0] as [string, { body: string }];
    expect(id).toBe('id-a');
    expect(arg.body).toBe('body of a');
  });

  it('isolates per-file errors; other files still process', async () => {
    await write('good.md', fixture('good', 'user'));
    await write('bad.md', '# no frontmatter here\n');
    const { store, create } = mkStore();
    const result = await importAutoMemoryDir(dir, store, { dryRun: false, existingIndex: idx({}) });
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toMatch(/bad\.md$/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('dry-run: no store writes/reads; existing reported as skipped', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    const { store, create, get, update } = mkStore({ 'id-a': 'whatever' });
    const result = await importAutoMemoryDir(dir, store, {
      dryRun: true,
      existingIndex: idx({ a: 'id-a' }),
    });
    expect(result).toEqual({ imported: 1, refreshed: 0, skipped: 1, errors: [] });
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('skips MEMORY.md (the index file) even when present', async () => {
    await write('MEMORY.md', '# index — not a memory entry\n');
    await write('a.md', fixture('a', 'feedback'));
    const { store, create } = mkStore();
    const result = await importAutoMemoryDir(dir, store, { dryRun: false, existingIndex: idx({}) });
    expect(result.imported).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fileWhitelist: only listed files processed', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    const { store, create } = mkStore();
    const result = await importAutoMemoryDir(dir, store, {
      dryRun: false,
      existingIndex: idx({}),
      fileWhitelist: ['b.md'],
    });
    expect(result).toEqual({ imported: 1, refreshed: 0, skipped: 0, errors: [] });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fileWhitelist: empty array → zero files processed', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { store, create } = mkStore();
    const result = await importAutoMemoryDir(dir, store, {
      dryRun: false,
      existingIndex: idx({}),
      fileWhitelist: [],
    });
    expect(result).toEqual({ imported: 0, refreshed: 0, skipped: 0, errors: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('scope mapping: feedback/user/reference → user; project → "project"', async () => {
    await write('f.md', fixture('f', 'feedback'));
    await write('u.md', fixture('u', 'user'));
    await write('r.md', fixture('r', 'reference'));
    await write('p.md', fixture('p', 'project'));
    const { store, create } = mkStore();
    await importAutoMemoryDir(dir, store, { dryRun: false, existingIndex: idx({}) });
    const scopes = create.mock.calls.map((c) => (c[0] as { scope: unknown }).scope);
    expect(scopes.filter((s) => s === 'user')).toHaveLength(3);
    expect(scopes.filter((s) => s === 'project')).toHaveLength(1);
  });

  it('passes the auto-memory name to store.create (the import marker source)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { store, create } = mkStore();
    await importAutoMemoryDir(dir, store, { dryRun: false, existingIndex: idx({}) });
    expect((create.mock.calls[0]?.[0] as { name: string }).name).toBe('a');
  });

  it('reconciles a duplicate name in one batch (create once, then skip)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('a-copy.md', fixture('a', 'feedback'));
    const { store, create, update } = mkStore({ 'mem-new-0': fixtureFolded('a') });
    const result = await importAutoMemoryDir(dir, store, { dryRun: false, existingIndex: idx({}) });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('fetchExistingImportIndex', () => {
  it('delegates to store.listImportIndex (the tag→name mapping lives in the handle)', async () => {
    const want = new Map([['foo', { id: '1' }]]);
    const store = { listImportIndex: vi.fn().mockResolvedValue(want) } as unknown as MemoryStore;
    const index = await fetchExistingImportIndex(store);
    expect([...index.entries()]).toEqual([['foo', { id: '1' }]]);
    expect((store.listImportIndex as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

describe('pruneOrphanedImports', () => {
  it('prunes an import entry whose source file is gone (store.delete)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { store, del } = mkStore();
    const result = await pruneOrphanedImports(dir, store, idx({ a: 'id-a', gone: 'id-gone' }), {
      dryRun: false,
    });
    expect(result).toEqual({ pruned: 1 });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[0]).toBe('id-gone');
  });

  it('keeps an entry whose source exists (by frontmatter name)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { store, del } = mkStore();
    const result = await pruneOrphanedImports(dir, store, idx({ a: 'id-a' }), { dryRun: false });
    expect(result).toEqual({ pruned: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it('basename guard: a malformed file still protects its store copy from prune', async () => {
    await write('foo.md', '# no frontmatter — readAutoMemory throws\n');
    const { store, del } = mkStore();
    const result = await pruneOrphanedImports(dir, store, idx({ foo: 'id-foo' }), {
      dryRun: false,
    });
    expect(result).toEqual({ pruned: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it('dry-run: counts orphans without deleting', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { store, del } = mkStore();
    const result = await pruneOrphanedImports(dir, store, idx({ a: 'id-a', gone: 'id-gone' }), {
      dryRun: true,
    });
    expect(result).toEqual({ pruned: 1 });
    expect(del).not.toHaveBeenCalled();
  });
});

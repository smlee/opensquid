/**
 * Unit tests for `importAutoMemoryDir` + `fetchExistingImportIndex` (G.6 + MAU.1).
 *
 * Real tmp dirs for the fixture files (the reader needs real I/O); the
 * `EngineClient` is stubbed so we assert orchestration only: scope mapping,
 * create / refresh / skip reconciliation, dry-run no-op, MEMORY.md skip,
 * whitelist filter, error isolation per file.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';

import {
  fetchExistingImportIndex,
  importAutoMemoryDir,
  IMPORT_HOST_PREFIX,
  pruneOrphanedImports,
  type ImportIndexEntry,
} from './auto_memory_importer.js';

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

/**
 * The body the reader produces for `fixture(name, …)`. The reader `.trim()`s
 * the body (auto_memory_reader.ts), so there is NO trailing newline — the
 * memoryGet stub must return this exact form for the unchanged-content compare.
 */
function fixtureBody(name: string): string {
  return `body of ${name}`;
}

async function write(file: string, contents: string): Promise<void> {
  await fs.writeFile(join(dir, file), contents, 'utf-8');
}

interface Engine {
  client: EngineClient;
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
}

/**
 * Stub engine. `storedContent` maps engine id → the content `memoryGet`
 * returns (models what's already persisted, for refresh-vs-skip tests).
 * `memoryCreate` mints deterministic ids `mem-new-0`, `mem-new-1`, …
 */
function mkEngine(
  storedContent: Record<string, string> = {},
  // MF.2 (H3): the engine-side description per id, so refresh-vs-skip can be exercised on
  // the DESCRIPTION surface (not just content). Defaults to 'd' (the prior fixed value).
  storedDesc: Record<string, string> = {},
): Engine {
  let n = 0;
  const create = vi.fn().mockImplementation(() =>
    Promise.resolve({
      id: `mem-new-${n++}`,
      description: 'd',
      created_at: 't',
      scope: 'user',
    }),
  );
  const get = vi.fn().mockImplementation(({ id }: { id: string }) =>
    Promise.resolve({
      id,
      description: storedDesc[id] ?? 'd',
      content: storedContent[id] ?? '',
      created_at: 't',
      scope: 'user',
    }),
  );
  const update = vi
    .fn()
    .mockResolvedValue({ id: 'x', description: 'd', content: 'c', scope: 'user' });
  const del = vi.fn().mockResolvedValue({ id: 'x', deleted: true });
  const client = {
    memoryCreate: create,
    memoryGet: get,
    memoryUpdate: update,
    memoryDelete: del,
  } as unknown as EngineClient;
  return { client, create, get, update, del };
}

function idx(entries: Record<string, string>): Map<string, ImportIndexEntry> {
  return new Map(Object.entries(entries).map(([name, id]) => [name, { id }]));
}

describe('importAutoMemoryDir', () => {
  it('imports all .md files when none exist; no errors', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    await write('c.md', fixture('c', 'project'));
    const { client, create } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({}),
    });
    expect(result).toEqual({ imported: 3, refreshed: 0, skipped: 0, errors: [] });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('skips an existing entry whose content AND description are unchanged', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    // MF.2: stored description matches the disk ('desc-a') so neither surface changed → skip.
    const { client, create, get, update } = mkEngine(
      { 'id-a': fixtureBody('a') },
      { 'id-a': 'desc-a' },
    );
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({ a: 'id-a' }),
    });
    expect(result).toEqual({ imported: 1, refreshed: 0, skipped: 1, errors: [] });
    expect(create).toHaveBeenCalledTimes(1); // only b (new)
    expect(get).toHaveBeenCalledTimes(1); // a content check
    expect(update).not.toHaveBeenCalled();
    expect((create.mock.calls[0]?.[0] as { description: string }).description).toBe('desc-b');
  });

  // MF.2 (H3): a description-only edit (body unchanged) MUST refresh — description is
  // load-bearing for retrieval (ADR-0005), so a stale engine description = wrong recall.
  it('refreshes an existing entry whose DESCRIPTION changed but body did not', async () => {
    await write('a.md', fixture('a', 'feedback')); // disk description = 'desc-a'
    const { client, get, update } = mkEngine(
      { 'id-a': fixtureBody('a') },
      { 'id-a': 'STALE desc' },
    );
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({ a: 'id-a' }),
    });
    expect(result).toEqual({ imported: 0, refreshed: 1, skipped: 0, errors: [] });
    expect(get).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0]?.[0] as { description: string }).description).toBe('desc-a');
  });

  it('refreshes an existing entry whose content changed (memoryUpdate, not create)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client, create, get, update } = mkEngine({ 'id-a': 'OLD body of a' });
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({ a: 'id-a' }),
    });
    expect(result).toEqual({ imported: 0, refreshed: 1, skipped: 0, errors: [] });
    expect(create).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]?.[0] as { id: string; content: string };
    expect(arg.id).toBe('id-a');
    expect(arg.content).toBe(fixtureBody('a'));
  });

  it('isolates per-file errors; other files still process', async () => {
    await write('good.md', fixture('good', 'user'));
    await write('bad.md', '# no frontmatter here\n');
    const { client, create } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({}),
    });
    expect(result.imported).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toMatch(/bad\.md$/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('dry-run: no engine calls (create/get/update); existing reported as skipped', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    const { client, create, get, update } = mkEngine({ 'id-a': 'whatever' });
    const result = await importAutoMemoryDir(dir, client, {
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
    const { client, create } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({}),
    });
    expect(result.imported).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fileWhitelist: only listed files processed; others ignored', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    await write('c.md', fixture('c', 'project'));
    const { client, create } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({}),
      fileWhitelist: ['b.md'],
    });
    expect(result).toEqual({ imported: 1, refreshed: 0, skipped: 0, errors: [] });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('fileWhitelist: empty array → zero files processed', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client, create } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({}),
      fileWhitelist: [],
    });
    expect(result).toEqual({ imported: 0, refreshed: 0, skipped: 0, errors: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('fileWhitelist: non-existent entry silently skipped (not an error)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({}),
      fileWhitelist: ['ghost.md', 'a.md'],
    });
    expect(result).toEqual({ imported: 1, refreshed: 0, skipped: 0, errors: [] });
  });

  it('scope mapping: feedback / user / reference → user; project → {project:""}', async () => {
    await write('f.md', fixture('f', 'feedback'));
    await write('u.md', fixture('u', 'user'));
    await write('r.md', fixture('r', 'reference'));
    await write('p.md', fixture('p', 'project'));
    const { client, create } = mkEngine();
    await importAutoMemoryDir(dir, client, { dryRun: false, existingIndex: idx({}) });
    const scopes = create.mock.calls.map((c) => (c[0] as { scope: unknown }).scope);
    expect(scopes.filter((s) => s === 'user')).toHaveLength(3);
    expect(scopes.filter((s) => typeof s === 'object')).toHaveLength(1);
    const projectCall = create.mock.calls.find(
      (c) => (c[0] as { description: string }).description === 'desc-p',
    );
    expect((projectCall?.[0] as { scope: unknown }).scope).toEqual({ project: '' });
  });

  it('always tags authored_by: user and round-trips name in origin.host', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client, create } = mkEngine();
    await importAutoMemoryDir(dir, client, { dryRun: false, existingIndex: idx({}) });
    const arg = create.mock.calls[0]?.[0] as { authored_by: string; origin: { host: string } };
    expect(arg.authored_by).toBe('user');
    expect(arg.origin.host).toBe(`${IMPORT_HOST_PREFIX}a`);
  });

  it('reconciles a duplicate name appearing twice in one batch (create once, then skip)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('a-copy.md', fixture('a', 'feedback')); // same `name: a` slug + body
    // The just-created entry is mem-new-0; its stored content == fixtureBody('a') AND its
    // description == the disk's 'desc-a' (what create wrote), so the 2nd occurrence's
    // content+description check is equal → skipped (not refreshed). (MF.2: model both.)
    const { client, create, update } = mkEngine(
      { 'mem-new-0': fixtureBody('a') },
      { 'mem-new-0': 'desc-a' },
    );
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingIndex: idx({}),
    });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('fetchExistingImportIndex', () => {
  it('maps name → { id } from origin.host marker; ignores non-import rows', async () => {
    const memoryList = vi.fn().mockResolvedValueOnce({
      total: 3,
      limit: 200,
      offset: 0,
      returned: 3,
      results: [
        {
          id: '1',
          description: 'a',
          scope: 'user',
          origin: { host: `${IMPORT_HOST_PREFIX}foo` },
          created_at: 't',
          updated_at: null,
          consumed_by_user_lessons: 0,
        },
        {
          id: '2',
          description: 'b',
          scope: 'user',
          origin: { host: 'opensquid-mcp:explicit' },
          created_at: 't',
          updated_at: null,
          consumed_by_user_lessons: 0,
        },
        {
          id: '3',
          description: 'c',
          scope: 'user',
          origin: null,
          created_at: 't',
          updated_at: null,
          consumed_by_user_lessons: 0,
        },
      ],
    });
    const client = { memoryList } as unknown as EngineClient;
    const index = await fetchExistingImportIndex(client);
    expect([...index.entries()]).toEqual([['foo', { id: '1' }]]);
    expect(memoryList).toHaveBeenCalledTimes(1);
  });

  it('pages until a partial page is returned', async () => {
    const fullPage = {
      total: 250,
      limit: 200,
      offset: 0,
      returned: 200,
      results: Array.from({ length: 200 }, (_, i) => ({
        id: `id-${i}`,
        description: `d-${i}`,
        scope: 'user' as const,
        origin: { host: `${IMPORT_HOST_PREFIX}n${i}` },
        created_at: 't',
        updated_at: null,
        consumed_by_user_lessons: 0,
      })),
    };
    const partialPage = {
      total: 250,
      limit: 200,
      offset: 200,
      returned: 50,
      results: Array.from({ length: 50 }, (_, i) => ({
        id: `id-${200 + i}`,
        description: `d-${200 + i}`,
        scope: 'user' as const,
        origin: { host: `${IMPORT_HOST_PREFIX}n${200 + i}` },
        created_at: 't',
        updated_at: null,
        consumed_by_user_lessons: 0,
      })),
    };
    const memoryList = vi.fn().mockResolvedValueOnce(fullPage).mockResolvedValueOnce(partialPage);
    const client = { memoryList } as unknown as EngineClient;
    const index = await fetchExistingImportIndex(client);
    expect(index.size).toBe(250);
    expect(memoryList).toHaveBeenCalledTimes(2);
  });
});

describe('pruneOrphanedImports', () => {
  it('prunes an import entry whose source file is gone (force-delete)', async () => {
    await write('a.md', fixture('a', 'feedback')); // a present
    const { client, del } = mkEngine();
    const result = await pruneOrphanedImports(dir, client, idx({ a: 'id-a', gone: 'id-gone' }), {
      dryRun: false,
    });
    expect(result).toEqual({ pruned: 1 });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[0]).toEqual({ id: 'id-gone', force: true });
  });

  it('keeps an entry whose source exists (by frontmatter name)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client, del } = mkEngine();
    const result = await pruneOrphanedImports(dir, client, idx({ a: 'id-a' }), { dryRun: false });
    expect(result).toEqual({ pruned: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it('basename guard: a malformed file still protects its engine copy from prune', async () => {
    await write('foo.md', '# no frontmatter — readAutoMemory throws\n');
    const { client, del } = mkEngine();
    const result = await pruneOrphanedImports(dir, client, idx({ foo: 'id-foo' }), {
      dryRun: false,
    });
    expect(result).toEqual({ pruned: 0 }); // kept via basename fallback
    expect(del).not.toHaveBeenCalled();
  });

  it('handles name != basename: keeps the named entry, prunes the truly-orphaned one', async () => {
    await write('y.md', fixture('x', 'feedback')); // file y.md, frontmatter name: x
    const { client, del } = mkEngine();
    const result = await pruneOrphanedImports(dir, client, idx({ x: 'id-x', z: 'id-z' }), {
      dryRun: false,
    });
    expect(result).toEqual({ pruned: 1 });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[0]).toEqual({ id: 'id-z', force: true });
  });

  it('dryRun: counts orphans without deleting', async () => {
    const { client, del } = mkEngine();
    const result = await pruneOrphanedImports(dir, client, idx({ gone: 'id-gone' }), {
      dryRun: true,
    });
    expect(result).toEqual({ pruned: 1 });
    expect(del).not.toHaveBeenCalled();
  });
});

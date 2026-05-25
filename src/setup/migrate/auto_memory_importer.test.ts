/**
 * Unit tests for `importAutoMemoryDir` + `fetchExistingImportNames`.
 *
 * Uses real tmp directories for the fixture files (the reader needs real
 * I/O) and stubs the `EngineClient` so we only assert orchestration:
 * scope mapping, dedup, dry-run no-op, MEMORY.md skip, whitelist filter,
 * error isolation per file.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';

import {
  fetchExistingImportNames,
  importAutoMemoryDir,
  IMPORT_HOST_PREFIX,
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

async function write(file: string, contents: string): Promise<void> {
  await fs.writeFile(join(dir, file), contents, 'utf-8');
}

function mkEngine(): { client: EngineClient; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn().mockResolvedValue({
    id: 'mem-x',
    description: 'd',
    created_at: '2026-05-24T00:00:00Z',
    scope: 'user',
  });
  const client = { memoryCreate: spy } as unknown as EngineClient;
  return { client, spy };
}

describe('importAutoMemoryDir', () => {
  it('imports all .md files when none exist; no errors', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    await write('c.md', fixture('c', 'project'));
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(),
    });
    expect(result).toEqual({ imported: 3, skipped: 0, errors: [] });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('skips entries whose name is already in existingNames', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(['a']),
    });
    expect(result).toEqual({ imported: 1, skipped: 1, errors: [] });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]?.[0] as { description: string };
    expect(call.description).toBe('desc-b');
  });

  it('isolates per-file errors; other files still process', async () => {
    await write('good.md', fixture('good', 'user'));
    await write('bad.md', '# no frontmatter here\n');
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(),
    });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toMatch(/bad\.md$/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('dry-run: memoryCreate never called; counts still accurate', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: true,
      existingNames: new Set(['a']),
    });
    expect(result).toEqual({ imported: 1, skipped: 1, errors: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips MEMORY.md (the index file) even when present', async () => {
    await write('MEMORY.md', '# index — not a memory entry\n');
    await write('a.md', fixture('a', 'feedback'));
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(),
    });
    expect(result.imported).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fileWhitelist: only listed files processed; others ignored', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('b.md', fixture('b', 'user'));
    await write('c.md', fixture('c', 'project'));
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(),
      fileWhitelist: ['b.md'],
    });
    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fileWhitelist: empty array → zero files processed', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(),
      fileWhitelist: [],
    });
    expect(result).toEqual({ imported: 0, skipped: 0, errors: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('fileWhitelist: non-existent entry silently skipped (not an error)', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(),
      fileWhitelist: ['ghost.md', 'a.md'],
    });
    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
  });

  it('scope mapping: feedback / user / reference → user; project → {project:""}', async () => {
    await write('f.md', fixture('f', 'feedback'));
    await write('u.md', fixture('u', 'user'));
    await write('r.md', fixture('r', 'reference'));
    await write('p.md', fixture('p', 'project'));
    const { client, spy } = mkEngine();
    await importAutoMemoryDir(dir, client, { dryRun: false, existingNames: new Set() });
    const scopes = spy.mock.calls.map((c) => (c[0] as { scope: unknown }).scope);
    const sortedByName = [...spy.mock.calls].sort((a, b) =>
      (a[0] as { description: string }).description.localeCompare(
        (b[0] as { description: string }).description,
      ),
    );
    expect(scopes.filter((s) => s === 'user')).toHaveLength(3);
    expect(scopes.filter((s) => typeof s === 'object')).toHaveLength(1);
    const projectCall = sortedByName.find(
      (c) => (c[0] as { description: string }).description === 'desc-p',
    );
    expect((projectCall?.[0] as { scope: unknown }).scope).toEqual({ project: '' });
  });

  it('always tags authored_by: user and round-trips name in origin.host', async () => {
    await write('a.md', fixture('a', 'feedback'));
    const { client, spy } = mkEngine();
    await importAutoMemoryDir(dir, client, { dryRun: false, existingNames: new Set() });
    const arg = spy.mock.calls[0]?.[0] as {
      authored_by: string;
      origin: { host: string };
    };
    expect(arg.authored_by).toBe('user');
    expect(arg.origin.host).toBe(`${IMPORT_HOST_PREFIX}a`);
  });

  it('dedupes a duplicate name appearing twice in one batch', async () => {
    await write('a.md', fixture('a', 'feedback'));
    await write('a-copy.md', fixture('a', 'feedback')); // same `name: a` slug
    const { client, spy } = mkEngine();
    const result = await importAutoMemoryDir(dir, client, {
      dryRun: false,
      existingNames: new Set(),
    });
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('fetchExistingImportNames', () => {
  it('extracts names from origin.host marker; ignores non-import rows', async () => {
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
    const names = await fetchExistingImportNames(client);
    expect(names).toEqual(new Set(['foo']));
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
    const names = await fetchExistingImportNames(client);
    expect(names.size).toBe(250);
    expect(memoryList).toHaveBeenCalledTimes(2);
  });
});

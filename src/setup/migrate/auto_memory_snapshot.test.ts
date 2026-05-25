/**
 * Unit tests for `snapshotAuto` — G.7 incremental catch-up over G.6.
 *
 * Uses real tmp directories for both the auto-memory source and the
 * opensquid-home target so we exercise the actual mtime + read/write path.
 * Engine is stubbed for `memoryList` + `memoryCreate`.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';

import { snapshotAuto, SNAPSHOT_FILE } from './auto_memory_snapshot.js';

let autoDir: string;
let home: string;

beforeEach(async () => {
  autoDir = await mkdtemp(join(tmpdir(), 'opensquid-snapshot-auto-'));
  home = await mkdtemp(join(tmpdir(), 'opensquid-snapshot-home-'));
});

afterEach(async () => {
  await rm(autoDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
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

async function writeMemory(file: string, contents: string): Promise<void> {
  await fs.writeFile(join(autoDir, file), contents, 'utf-8');
}

function mkEngine(existingNames: string[] = []): {
  client: EngineClient;
  memoryCreate: ReturnType<typeof vi.fn>;
  memoryList: ReturnType<typeof vi.fn>;
} {
  const memoryCreate = vi.fn().mockResolvedValue({
    id: 'mem-x',
    description: 'd',
    created_at: '2026-05-24T00:00:00Z',
    scope: 'user',
  });
  const results = existingNames.map((name) => ({
    id: name,
    description: name,
    scope: 'user' as const,
    origin: { host: `opensquid-import:auto-memory:${name}` },
    created_at: 't',
    updated_at: null,
    consumed_by_user_lessons: 0,
  }));
  const memoryList = vi.fn().mockResolvedValue({
    total: results.length,
    limit: 200,
    offset: 0,
    returned: results.length,
    results,
  });
  const client = { memoryCreate, memoryList } as unknown as EngineClient;
  return { client, memoryCreate, memoryList };
}

describe('snapshotAuto', () => {
  it('first run (no snapshot file) imports ALL files and writes the timestamp', async () => {
    await writeMemory('a.md', fixture('a', 'feedback'));
    await writeMemory('b.md', fixture('b', 'user'));
    await writeMemory('MEMORY.md', '# index — skip\n');
    const { client, memoryCreate } = mkEngine();

    const before = Date.now();
    const result = await snapshotAuto(autoDir, home, client);
    const after = Date.now();

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(memoryCreate).toHaveBeenCalledTimes(2);

    const stamp = Number((await fs.readFile(join(home, SNAPSHOT_FILE), 'utf-8')).trim());
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  it('second run with no changes imports zero files (mtime ≤ snapshot)', async () => {
    await writeMemory('a.md', fixture('a', 'feedback'));
    const { client: c1 } = mkEngine();
    await snapshotAuto(autoDir, home, c1);
    // Bump the snapshot a hair into the future so we deterministically beat the
    // file's mtime even on coarse fs clocks.
    const stampPath = join(home, SNAPSHOT_FILE);
    await fs.writeFile(stampPath, String(Date.now() + 5000), 'utf-8');

    const { client: c2, memoryCreate } = mkEngine(['a']);
    const result = await snapshotAuto(autoDir, home, c2);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(memoryCreate).not.toHaveBeenCalled();
  });

  it('second run imports only files modified AFTER the snapshot timestamp', async () => {
    await writeMemory('a.md', fixture('a', 'feedback'));
    await writeMemory('b.md', fixture('b', 'user'));
    // Pin the snapshot file BETWEEN the two writes by stamping in the middle
    // and then touching b.md with a future mtime.
    const cutoff = Date.now();
    await fs.writeFile(join(home, SNAPSHOT_FILE), String(cutoff), 'utf-8');
    const future = new Date(cutoff + 60_000);
    await fs.utimes(join(autoDir, 'a.md'), future, new Date(cutoff - 60_000));
    await fs.utimes(join(autoDir, 'b.md'), future, future);

    const { client, memoryCreate } = mkEngine();
    const result = await snapshotAuto(autoDir, home, client);
    expect(result.imported).toBe(1);
    expect(memoryCreate).toHaveBeenCalledTimes(1);
    const arg = memoryCreate.mock.calls[0]?.[0] as { description: string };
    expect(arg.description).toBe('desc-b');
  });

  it('dedup via existingNames still applies on top of the mtime filter', async () => {
    await writeMemory('a.md', fixture('a', 'feedback'));
    // Snapshot file absent → all files are candidates; but engine already has `a`.
    const { client, memoryCreate } = mkEngine(['a']);
    const result = await snapshotAuto(autoDir, home, client);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(memoryCreate).not.toHaveBeenCalled();
  });

  it('snapshot file with corrupt content treated as missing (lastSnapshot = 0)', async () => {
    await writeMemory('a.md', fixture('a', 'feedback'));
    await fs.writeFile(join(home, SNAPSHOT_FILE), 'not-a-number\n', 'utf-8');
    const { client, memoryCreate } = mkEngine();
    const result = await snapshotAuto(autoDir, home, client);
    expect(result.imported).toBe(1);
    expect(memoryCreate).toHaveBeenCalledTimes(1);
  });

  it('writes the timestamp even when per-file errors occurred (no replay loop)', async () => {
    await writeMemory('good.md', fixture('good', 'feedback'));
    await writeMemory('bad.md', '# no frontmatter\n');
    const { client } = mkEngine();
    const result = await snapshotAuto(autoDir, home, client);
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    const stamp = (await fs.readFile(join(home, SNAPSHOT_FILE), 'utf-8')).trim();
    expect(Number(stamp)).toBeGreaterThan(0);
  });

  it('creates opensquidHome dir on demand (first run, fresh install)', async () => {
    await rm(home, { recursive: true, force: true });
    await writeMemory('a.md', fixture('a', 'feedback'));
    const { client } = mkEngine();
    await snapshotAuto(autoDir, home, client);
    const exists = await fs
      .stat(join(home, SNAPSHOT_FILE))
      .then((s) => s.isFile())
      .catch(() => false);
    expect(exists).toBe(true);
  });
});

/**
 * Tests for the shared atomic-file helper (T-WORKGRAPH-EVENTSOURCED slice 1d).
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atomicWriteFile, safeRecordId } from './atomic_file.js';

describe('atomic_file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'af-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('atomicWriteFile creates parent dirs, writes content, leaves no .tmp', async () => {
    const p = join(dir, 'sub', 'x.json');
    await atomicWriteFile(p, '{"a":1}');
    expect(await readFile(p, 'utf8')).toBe('{"a":1}');
    expect((await readdir(join(dir, 'sub'))).filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('supports overlapping publishers to one target without temp-file rename races', async () => {
    const path = join(dir, 'reports', 'same.md');
    const values = Array.from({ length: 20 }, (_, index) => `report-${String(index)}`);
    await expect(
      Promise.all(values.map((value) => atomicWriteFile(path, value))),
    ).resolves.toHaveLength(values.length);
    expect(values).toContain(await readFile(path, 'utf8'));
    expect((await readdir(join(dir, 'reports'))).filter((file) => file.includes('.tmp'))).toEqual(
      [],
    );
  });

  it('safeRecordId rejects path-escaping or empty ids', () => {
    expect(safeRecordId('wg-abc')).toBe('wg-abc');
    expect(() => safeRecordId('../escape')).toThrow(/unsafe/);
    expect(() => safeRecordId('a/b')).toThrow(/unsafe/);
    expect(() => safeRecordId('a\\b')).toThrow(/unsafe/);
    expect(() => safeRecordId('')).toThrow(/unsafe/);
  });
});

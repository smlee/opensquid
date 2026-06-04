/**
 * Tests for `computeMemoryDrift` + `renderMemoryDrift` (MAU.4).
 *
 * Real tmp dir for the auto-memory files; stubbed engine for the import index
 * (memoryList) + content lookups (memoryGet). The "engine error propagates"
 * case is the anti-silence anchor: a failed probe must NOT return inSync:true.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';

import { IMPORT_HOST_PREFIX } from './auto_memory_importer.js';
import { computeMemoryDrift, renderMemoryDrift } from './memory_drift.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mau4-drift-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(name: string): string {
  return `---\nname: ${name}\ndescription: "d-${name}"\nmetadata:\n  type: feedback\n---\nbody of ${name}\n`;
}
const bodyOf = (name: string): string => `body of ${name}`; // reader trims trailing \n

async function write(file: string, contents: string): Promise<void> {
  await fs.writeFile(join(dir, file), contents, 'utf8');
}

/**
 * Stub engine. `engineEntries`: name → stored content (modeled as import-marked
 * rows id=name). `getThrows` makes memoryGet reject (probe-failure case).
 */
function mkEngine(
  engineEntries: Record<string, string>,
  opts: { listThrows?: boolean; getThrows?: string } = {},
): EngineClient {
  const results = Object.keys(engineEntries).map((name) => ({
    id: name,
    description: name,
    scope: 'user' as const,
    origin: { host: `${IMPORT_HOST_PREFIX}${name}` },
    created_at: 't',
    updated_at: null,
    consumed_by_user_lessons: 0,
  }));
  const memoryList = opts.listThrows
    ? vi.fn().mockRejectedValue(new Error('engine down'))
    : vi.fn().mockResolvedValue({
        total: results.length,
        limit: 200,
        offset: 0,
        returned: results.length,
        results,
      });
  const memoryGet = vi.fn().mockImplementation(({ id }: { id: string }) =>
    opts.getThrows === id
      ? Promise.reject(new Error('engine down'))
      : Promise.resolve({
          id,
          description: id,
          content: engineEntries[id] ?? '',
          created_at: 't',
          scope: 'user',
        }),
  );
  return { memoryList, memoryGet } as unknown as EngineClient;
}

describe('computeMemoryDrift', () => {
  it('reports inSync when disk and engine match', async () => {
    await write('a.md', fixture('a'));
    await write('b.md', fixture('b'));
    const engine = mkEngine({ a: bodyOf('a'), b: bodyOf('b') });
    const d = await computeMemoryDrift(dir, engine);
    expect(d.inSync).toBe(true);
    expect(d).toMatchObject({
      missing: [],
      stale: [],
      orphaned: [],
      total: { disk: 2, engineImported: 2 },
    });
  });

  it('flags a disk file with no engine entry as missing', async () => {
    await write('a.md', fixture('a'));
    const engine = mkEngine({}); // engine has nothing
    const d = await computeMemoryDrift(dir, engine);
    expect(d.inSync).toBe(false);
    expect(d.missing).toEqual(['a']);
  });

  it('flags an entry whose engine content differs as stale', async () => {
    await write('a.md', fixture('a'));
    const engine = mkEngine({ a: 'OLD body of a' });
    const d = await computeMemoryDrift(dir, engine);
    expect(d.stale).toEqual(['a']);
    expect(d.missing).toEqual([]);
  });

  it('flags an import-marked engine entry with no source file as orphaned', async () => {
    await write('a.md', fixture('a'));
    const engine = mkEngine({ a: bodyOf('a'), gone: bodyOf('gone') });
    const d = await computeMemoryDrift(dir, engine);
    expect(d.orphaned).toEqual(['gone']);
    expect(d.inSync).toBe(false);
  });

  it('PROPAGATES an engine error (never reports a falsely-clean inSync)', async () => {
    await write('a.md', fixture('a'));
    const engine = mkEngine({}, { listThrows: true });
    await expect(computeMemoryDrift(dir, engine)).rejects.toThrow(/engine down/);
  });

  // MF.3 (M1): the OTHER engine call — per-entry memoryGet (memory_drift.ts:74) — must also
  // propagate, not be swallowed into a falsely-clean inSync. listThrows only exercises the
  // memoryList path; this exercises a mid-loop memoryGet rejection.
  it('PROPAGATES a mid-loop memoryGet rejection (never a falsely-clean inSync)', async () => {
    await write('a.md', fixture('a'));
    await write('b.md', fixture('b'));
    const engine = mkEngine({ a: bodyOf('a'), b: bodyOf('b') }, { getThrows: 'b' });
    await expect(computeMemoryDrift(dir, engine)).rejects.toThrow(/engine down/);
  });
});

describe('renderMemoryDrift', () => {
  it('renders in-sync', () => {
    expect(
      renderMemoryDrift({
        inSync: true,
        missing: [],
        stale: [],
        orphaned: [],
        total: { disk: 5, engineImported: 5 },
      }),
    ).toBe('memory: in sync (5 indexed)');
  });
  it('renders a drift summary with counts', () => {
    const s = renderMemoryDrift({
      inSync: false,
      missing: ['a', 'b'],
      stale: ['c'],
      orphaned: [],
      total: { disk: 3, engineImported: 1 },
    });
    expect(s).toMatch(/DRIFT — 2 missing, 1 stale \(disk 3, indexed 1\)/);
  });
});

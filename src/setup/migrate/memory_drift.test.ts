/**
 * Tests for `computeMemoryDrift` + `renderMemoryDrift` (MAU.4, retire-Rust RES-5b). Real tmp dir for
 * the auto-memory files; a stubbed `MemoryStore` for the import index (listImportIndex) + content
 * lookups (get). The "store error propagates" case is the anti-silence anchor: a failed probe must
 * NOT return inSync:true. The disk side folds `description\n\nbody` (content-only store).
 */

import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeMemoryDrift, renderMemoryDrift } from './memory_drift.js';
import { folded, type MemoryStore } from './memory_store_handle.js';

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
/** The FOLDED content a synced store holds for `fixture(name)` = `d-<name>\n\nbody of <name>`. */
const storedFolded = (name: string): string => folded(`d-${name}`, `body of ${name}`);

async function write(file: string, contents: string): Promise<void> {
  await fs.writeFile(join(dir, file), contents, 'utf8');
}

/**
 * Stub MemoryStore. `entries`: name → stored (folded) content; listImportIndex maps name → {id:name}.
 * `listThrows`/`getThrows` exercise the fail-loud probe-error propagation.
 */
function mkStore(
  entries: Record<string, string>,
  opts: { listThrows?: boolean; getThrows?: string } = {},
): MemoryStore {
  const index = new Map(Object.keys(entries).map((name) => [name, { id: name }]));
  const listImportIndex = opts.listThrows
    ? vi.fn().mockRejectedValue(new Error('store down'))
    : vi.fn().mockResolvedValue(index);
  const get = vi
    .fn()
    .mockImplementation((id: string) =>
      opts.getThrows === id
        ? Promise.reject(new Error('store down'))
        : Promise.resolve(entries[id] !== undefined ? { content: entries[id] } : null),
    );
  return {
    listImportIndex,
    get,
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    close: () => Promise.resolve(),
  };
}

describe('computeMemoryDrift', () => {
  it('reports inSync when disk and store match (folded)', async () => {
    await write('a.md', fixture('a'));
    await write('b.md', fixture('b'));
    const store = mkStore({ a: storedFolded('a'), b: storedFolded('b') });
    const d = await computeMemoryDrift(dir, store);
    expect(d.inSync).toBe(true);
    expect(d).toMatchObject({
      missing: [],
      stale: [],
      orphaned: [],
      total: { disk: 2, engineImported: 2 },
    });
  });

  it('flags a disk file with no store entry as missing', async () => {
    await write('a.md', fixture('a'));
    const store = mkStore({});
    const d = await computeMemoryDrift(dir, store);
    expect(d.inSync).toBe(false);
    expect(d.missing).toEqual(['a']);
  });

  it('flags an entry whose store content differs as stale', async () => {
    await write('a.md', fixture('a'));
    const store = mkStore({ a: folded('d-a', 'OLD body of a') });
    const d = await computeMemoryDrift(dir, store);
    expect(d.stale).toEqual(['a']);
    expect(d.missing).toEqual([]);
  });

  it('flags an import-marked store entry with no source file as orphaned', async () => {
    await write('a.md', fixture('a'));
    const store = mkStore({ a: storedFolded('a'), gone: storedFolded('gone') });
    const d = await computeMemoryDrift(dir, store);
    expect(d.orphaned).toEqual(['gone']);
    expect(d.inSync).toBe(false);
  });

  it('PROPAGATES a store list error (never a falsely-clean inSync)', async () => {
    await write('a.md', fixture('a'));
    const store = mkStore({}, { listThrows: true });
    await expect(computeMemoryDrift(dir, store)).rejects.toThrow(/store down/);
  });

  it('PROPAGATES a mid-loop get rejection (never a falsely-clean inSync)', async () => {
    await write('a.md', fixture('a'));
    await write('b.md', fixture('b'));
    const store = mkStore({ a: storedFolded('a'), b: storedFolded('b') }, { getThrows: 'b' });
    await expect(computeMemoryDrift(dir, store)).rejects.toThrow(/store down/);
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

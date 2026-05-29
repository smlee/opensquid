/**
 * T-SIC SIC.1 — direct unit tests for `src/setup/cli/state_io.ts`.
 *
 * Strategy: per-test `mkdtemp` fixture (matches `src/runtime/paths.test.ts`
 * precedent). Helpers tested in isolation; the migrated `*_state.ts` files
 * (SIC.2) keep their own integration suites — those serve as the
 * end-to-end regression net for the consolidation.
 *
 * Case map:
 *   - writeKeyedYamlList: empty-list byte form (L9); populated list;
 *     parent mkdir; .tmp cleanup post-rename
 *   - readKeyedYamlList: ENOENT default both branches; empty file; missing
 *     key; malformed YAML; root is list; key is scalar; predicate filter
 *   - appendJsonlEntry + readJsonlEntries: round-trip; ENOENT empty;
 *     malformed-line skip (L11); parent mkdir
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendJsonlEntry,
  readJsonlEntries,
  readKeyedYamlList,
  writeKeyedYamlList,
} from './state_io.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-state-io-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const isString = (v: unknown): v is string => typeof v === 'string';

interface Item {
  id: string;
}
const isItem = (v: unknown): v is Item =>
  typeof v === 'object' && v !== null && typeof (v as Item).id === 'string';

// ---------------------------------------------------------------------------
// writeKeyedYamlList
// ---------------------------------------------------------------------------

describe('writeKeyedYamlList', () => {
  it('writes the literal `${key}: []\\n` on an empty list (byte-preserves L9)', async () => {
    const path = join(dir, 'a.yaml');
    await writeKeyedYamlList(path, 'subscriptions', []);
    expect(await readFile(path, 'utf8')).toBe('subscriptions: []\n');
  });

  it('writes a populated list via yaml.stringify', async () => {
    const path = join(dir, 'a.yaml');
    await writeKeyedYamlList<Item>(path, 'items', [{ id: 'x' }, { id: 'y' }]);
    const body = await readFile(path, 'utf8');
    expect(body).toContain('items:');
    expect(body).toContain('id: x');
    expect(body).toContain('id: y');
  });

  it('mkdir -p the parent directory chain', async () => {
    const path = join(dir, 'nested', 'sub', 'file.yaml');
    await writeKeyedYamlList<string>(path, 'k', ['a']);
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('removes the .tmp sentinel after successful rename', async () => {
    const path = join(dir, 'a.yaml');
    await writeKeyedYamlList<string>(path, 'k', ['a']);
    await expect(stat(`${path}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------
// readKeyedYamlList
// ---------------------------------------------------------------------------

describe('readKeyedYamlList', () => {
  it('returns defaultValue on ENOENT (explicit default)', async () => {
    const path = join(dir, 'absent.yaml');
    expect(await readKeyedYamlList(path, 'k', 'absent', isString, ['fallback'])).toEqual([
      'fallback',
    ]);
  });

  it('returns [] by default on ENOENT', async () => {
    const path = join(dir, 'absent.yaml');
    expect(await readKeyedYamlList(path, 'k', 'absent', isString)).toEqual([]);
  });

  it('returns [] on empty root mapping', async () => {
    const path = join(dir, 'empty.yaml');
    await writeFile(path, '\n', 'utf8');
    expect(await readKeyedYamlList(path, 'k', 'empty', isString)).toEqual([]);
  });

  it('returns [] when the key is missing', async () => {
    const path = join(dir, 'noKey.yaml');
    await writeFile(path, 'other: []\n', 'utf8');
    expect(await readKeyedYamlList(path, 'k', 'noKey', isString)).toEqual([]);
  });

  it('throws on malformed YAML with the label prefix', async () => {
    const path = join(dir, 'bad.yaml');
    // Unterminated flow-sequence — yaml package rejects.
    await writeFile(path, 'key: [unterminated\n', 'utf8');
    await expect(readKeyedYamlList(path, 'k', 'bad.yaml', isString)).rejects.toThrow(
      /bad\.yaml is malformed/,
    );
  });

  it('throws when the root is a list instead of a mapping', async () => {
    const path = join(dir, 'list.yaml');
    await writeFile(path, '- 1\n- 2\n', 'utf8');
    await expect(readKeyedYamlList(path, 'k', 'list.yaml', isString)).rejects.toThrow(
      /must be a mapping/,
    );
  });

  it('throws when the key value is not a list', async () => {
    const path = join(dir, 'scalar.yaml');
    await writeFile(path, 'k: not-a-list\n', 'utf8');
    await expect(readKeyedYamlList(path, 'k', 'scalar.yaml', isString)).rejects.toThrow(
      /must be a list/,
    );
  });

  it('filters per-row via predicate (drops invalid rows silently)', async () => {
    const path = join(dir, 'mixed.yaml');
    await writeFile(path, 'k:\n  - good\n  - 42\n  - alsoGood\n', 'utf8');
    expect(await readKeyedYamlList(path, 'k', 'mixed.yaml', isString)).toEqual([
      'good',
      'alsoGood',
    ]);
  });
});

// ---------------------------------------------------------------------------
// appendJsonlEntry + readJsonlEntries
// ---------------------------------------------------------------------------

describe('appendJsonlEntry + readJsonlEntries', () => {
  it('round-trips: three appends → readJsonlEntries returns them in order', async () => {
    const path = join(dir, 'audit.jsonl');
    await appendJsonlEntry(path, { v: 1 });
    await appendJsonlEntry(path, { v: 2 });
    await appendJsonlEntry(path, { v: 3 });
    expect(await readJsonlEntries(path)).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
  });

  it('readJsonlEntries returns [] on ENOENT', async () => {
    const path = join(dir, 'absent.jsonl');
    expect(await readJsonlEntries(path)).toEqual([]);
  });

  it('readJsonlEntries skips malformed lines silently (L11)', async () => {
    const path = join(dir, 'mixed.jsonl');
    await writeFile(
      path,
      `${JSON.stringify({ v: 1 })}\n{ not json\n${JSON.stringify({ v: 3 })}\n`,
      'utf8',
    );
    expect(await readJsonlEntries(path)).toEqual([{ v: 1 }, { v: 3 }]);
  });

  it('appendJsonlEntry mkdir -p the parent directory chain', async () => {
    const path = join(dir, 'nested', 'sub', 'log.jsonl');
    await appendJsonlEntry(path, { v: 1 });
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('readJsonlEntries treats predicate-typed generic correctly', async () => {
    interface E {
      v: number;
    }
    const path = join(dir, 'typed.jsonl');
    await appendJsonlEntry(path, { v: 99 });
    const out = await readJsonlEntries<E>(path);
    expect(out[0]?.v).toBe(99);
  });
});

// Predicate object-shape filtering (proves the helper also accepts non-string T).
describe('readKeyedYamlList — object-shape predicate', () => {
  it('filters by structural predicate (object with required field)', async () => {
    const path = join(dir, 'objs.yaml');
    await writeFile(path, 'items:\n  - id: a\n  - notId: b\n  - id: c\n  - "scalar"\n', 'utf8');
    const out = await readKeyedYamlList<Item>(path, 'items', 'objs.yaml', isItem);
    expect(out.map((i) => i.id)).toEqual(['a', 'c']);
  });
});

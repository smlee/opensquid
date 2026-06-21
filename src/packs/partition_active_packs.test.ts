/**
 * FAC-CUT.5a — partitionActivePacks: single-pass split of the active packs into v1 (`manifest.yaml`) and
 * v2 (`pack.yaml`) by format, via the open-and-catch resolver `loadActiveEntry`. Proves: v1 resolution is
 * preserved 1:1 vs the prior fallback loader (scope-first, builtin fallback, empty-dir edge,
 * not-found throw); only the additive `pack.yaml` → v2 case is new; malformed packs fail LOUD; and
 * `discoverActivePacks` (the thin `.v1` wrapper) is byte-compatible with its old contract.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverActivePacks, partitionActivePacks } from './discovery.js';

let scopeRoot: string;
let builtinRoot: string;

async function writeActiveJson(root: string, names: string[]): Promise<void> {
  await writeFile(join(root, 'active.json'), JSON.stringify({ packs: names }), 'utf8');
}

/** A v1 pack: `<root>/packs/<name>/manifest.yaml`. */
async function writeV1Pack(root: string, name: string, scope = 'workflow'): Promise<void> {
  const dir = join(root, 'packs', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.yaml'),
    [`name: ${name}`, 'version: 0.1.0', `scope: ${scope}`, 'goal: v1 fixture'].join('\n') + '\n',
    'utf8',
  );
}

/** A BUILTIN v1 pack: `<builtinRoot>/<name>/manifest.yaml` — the builtin root IS the pack-containing dir
 *  (`resolveBuiltinScopeRoot` → `<npm>/packs/builtin`), so packs are its DIRECT children (not under packs/). */
async function writeBuiltinV1Pack(name: string): Promise<void> {
  const dir = join(builtinRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.yaml'),
    [`name: ${name}`, 'version: 0.1.0', 'scope: workflow', 'goal: builtin fixture'].join('\n') +
      '\n',
    'utf8',
  );
}

/** A v2 cartridge: `<root>/packs/<name>/pack.yaml` (minimal valid PackV2, foundation form). */
async function writeV2Pack(root: string, name: string): Promise<void> {
  const dir = join(root, 'packs', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'pack.yaml'),
    [`name: ${name}`, 'version: 1.0.0', 'scope: workflow', 'foundation:', '  domains: [test]'].join(
      '\n',
    ) + '\n',
    'utf8',
  );
}

beforeEach(async () => {
  scopeRoot = await mkdtemp(join(tmpdir(), 'osq-partition-scope-'));
  builtinRoot = await mkdtemp(join(tmpdir(), 'osq-partition-builtin-'));
});
afterEach(async () => {
  await rm(scopeRoot, { recursive: true, force: true });
  await rm(builtinRoot, { recursive: true, force: true });
});

describe('partitionActivePacks — v1/v2 split + v1-resolution preservation', () => {
  it('scopeRoot === null → both lists empty', async () => {
    expect(await partitionActivePacks(null)).toEqual({ v1: [], v2: [] });
  });

  it('active.json ENOENT → both lists empty', async () => {
    expect(await partitionActivePacks(scopeRoot)).toEqual({ v1: [], v2: [] });
  });

  it('a scope manifest.yaml pack → v1 (preserved); v2 empty', async () => {
    await writeActiveJson(scopeRoot, ['a']);
    await writeV1Pack(scopeRoot, 'a');
    const { v1, v2 } = await partitionActivePacks(scopeRoot, null, builtinRoot);
    expect(v1.map((p) => p.name)).toEqual(['a']);
    expect(v2).toEqual([]);
  });

  it('no scope dir but a builtin manifest.yaml → v1 from builtin (fallback preserved)', async () => {
    await writeActiveJson(scopeRoot, ['b']);
    await writeBuiltinV1Pack('b');
    const { v1 } = await partitionActivePacks(scopeRoot, null, builtinRoot);
    expect(v1.map((p) => p.name)).toEqual(['b']);
  });

  it('scope dir present but EMPTY (no manifest, no pack.yaml) + builtin manifest → v1 from builtin', async () => {
    await writeActiveJson(scopeRoot, ['c']);
    await mkdir(join(scopeRoot, 'packs', 'c'), { recursive: true }); // empty scope dir
    await writeBuiltinV1Pack('c');
    const { v1 } = await partitionActivePacks(scopeRoot, null, builtinRoot);
    expect(v1.map((p) => p.name)).toEqual(['c']); // neither file at scope → falls to builtin
  });

  it('a scope pack.yaml → v2 cartridge; v1 empty', async () => {
    await writeActiveJson(scopeRoot, ['d']);
    await writeV2Pack(scopeRoot, 'd');
    const { v1, v2 } = await partitionActivePacks(scopeRoot, null, builtinRoot);
    expect(v1).toEqual([]);
    expect(v2.map((c) => c.pack.name)).toEqual(['d']);
  });

  it('a dir with BOTH pack.yaml + manifest.yaml → v2 wins (in-place upgrade)', async () => {
    await writeActiveJson(scopeRoot, ['e']);
    await writeV1Pack(scopeRoot, 'e');
    await writeV2Pack(scopeRoot, 'e'); // same dir now has both
    const { v1, v2 } = await partitionActivePacks(scopeRoot, null, builtinRoot);
    expect(v1).toEqual([]);
    expect(v2.map((c) => c.pack.name)).toEqual(['e']);
  });

  it('mixed active set → partitioned by format', async () => {
    await writeActiveJson(scopeRoot, ['v1pack', 'v2pack']);
    await writeV1Pack(scopeRoot, 'v1pack');
    await writeV2Pack(scopeRoot, 'v2pack');
    const { v1, v2 } = await partitionActivePacks(scopeRoot, null, builtinRoot);
    expect(v1.map((p) => p.name)).toEqual(['v1pack']);
    expect(v2.map((c) => c.pack.name)).toEqual(['v2pack']);
  });

  it('a name absent at both scope and builtin → throws not-found', async () => {
    await writeActiveJson(scopeRoot, ['ghost']);
    await expect(partitionActivePacks(scopeRoot, null, builtinRoot)).rejects.toThrow(/not found/i);
  });

  it('a MALFORMED pack.yaml (fails PackV2.parse, non-ENOENT) fails LOUD — not skipped to v1', async () => {
    await writeActiveJson(scopeRoot, ['bad']);
    const dir = join(scopeRoot, 'packs', 'bad');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pack.yaml'), 'version: 1.0.0\nscope: workflow\n', 'utf8'); // missing `name`
    await writeFile(
      join(dir, 'manifest.yaml'),
      'name: bad\nversion: 0.1.0\nscope: workflow\ngoal: x\n',
      'utf8',
    );
    await expect(partitionActivePacks(scopeRoot, null, builtinRoot)).rejects.toThrow();
  });
});

describe('discoverActivePacks — thin .v1 wrapper (unchanged contract)', () => {
  it('returns the v1 packs only (a v2 cartridge is absent from the v1 list)', async () => {
    await writeActiveJson(scopeRoot, ['v1pack', 'v2pack']);
    await writeV1Pack(scopeRoot, 'v1pack');
    await writeV2Pack(scopeRoot, 'v2pack');
    const packs = await discoverActivePacks(scopeRoot, null, builtinRoot);
    expect(packs.map((p) => p.name)).toEqual(['v1pack']);
  });

  it('null scope → []', async () => {
    expect(await discoverActivePacks(null)).toEqual([]);
  });
});

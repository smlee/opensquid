/**
 * Tests for `discoverActivePacks` (G.1 — Part A of the gap closure).
 *
 * Fixture strategy: build a tmpdir scope-root per test so isolation is
 * cheap, no `OPENSQUID_HOME` mutation is needed (the function takes the
 * scope root as an explicit arg), and there's zero risk of touching the
 * real `~/.opensquid/`.
 *
 * Coverage matches spec §"Test fixtures":
 *   - scopeRoot=null → []
 *   - active.json ENOENT → []
 *   - active.json malformed JSON → throws
 *   - active.json missing `packs:` field → throws with clear message
 *   - active.json references a missing pack folder → loadPack throws (propagated)
 *   - active.json with one valid pack → returns 1 Pack
 *   - additional: active.json with `packs: []` → returns [] (opt-in but empty)
 *   - additional: active.json with `packs: [123]` (non-string) → throws
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverActivePacks } from './discovery.js';

let scopeRoot: string;

async function writeActive(json: unknown): Promise<void> {
  await writeFile(join(scopeRoot, 'active.json'), JSON.stringify(json), 'utf8');
}

async function writeValidPack(name: string, scope = 'workflow'): Promise<void> {
  const packDir = join(scopeRoot, 'packs', name);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, 'manifest.yaml'),
    [`name: ${name}`, 'version: 0.1.0', `scope: ${scope}`, 'goal: test fixture'].join('\n') + '\n',
    'utf8',
  );
}

beforeEach(async () => {
  scopeRoot = await mkdtemp(join(tmpdir(), 'opensquid-discovery-'));
});

afterEach(async () => {
  await rm(scopeRoot, { recursive: true, force: true });
});

describe('discoverActivePacks — absent / empty branches', () => {
  it('returns [] when scopeRoot is null (project-scope absent case)', async () => {
    await expect(discoverActivePacks(null)).resolves.toEqual([]);
  });

  it('returns [] when active.json does not exist (scope present, no opt-in)', async () => {
    // scopeRoot is a fresh tmpdir; no active.json written.
    await expect(discoverActivePacks(scopeRoot)).resolves.toEqual([]);
  });

  it('returns [] when active.json declares an empty packs array', async () => {
    await writeActive({ packs: [] });
    await expect(discoverActivePacks(scopeRoot)).resolves.toEqual([]);
  });
});

describe('discoverActivePacks — malformed input fails LOUD', () => {
  it('throws a path-bearing error when active.json is malformed JSON', async () => {
    await writeFile(join(scopeRoot, 'active.json'), '{ this is not json', 'utf8');
    await expect(discoverActivePacks(scopeRoot)).rejects.toThrow(/active\.json/);
  });

  it('throws when active.json is missing the packs: field', async () => {
    await writeActive({ wrongField: true });
    let err: unknown;
    try {
      await discoverActivePacks(scopeRoot);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('packs');
    expect((err as Error).message).toContain('active.json');
  });

  it('throws when packs entries are not non-empty strings', async () => {
    await writeActive({ packs: [123] });
    await expect(discoverActivePacks(scopeRoot)).rejects.toThrow(/packs\[0\]/);
  });

  it('propagates loadPack errors when a referenced pack folder is missing', async () => {
    await writeActive({ packs: ['nonexistent'] });
    // loadPack throws because `manifest.yaml` cannot be read; the path
    // bears the missing manifest path so users can fix the typo.
    await expect(discoverActivePacks(scopeRoot)).rejects.toThrow(/manifest\.yaml/);
  });
});

describe('discoverActivePacks — happy path', () => {
  it('loads a single valid pack referenced in active.json', async () => {
    await writeValidPack('sangmin-personal-rules', 'workflow');
    await writeActive({ packs: ['sangmin-personal-rules'] });

    const packs = await discoverActivePacks(scopeRoot);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe('sangmin-personal-rules');
    expect(packs[0]?.scope).toBe('workflow');
  });

  it('loads multiple packs in active.json order', async () => {
    await writeValidPack('first-pack', 'universal');
    await writeValidPack('second-pack', 'project');
    await writeActive({ packs: ['first-pack', 'second-pack'] });

    const packs = await discoverActivePacks(scopeRoot);
    expect(packs.map((p) => p.name)).toEqual(['first-pack', 'second-pack']);
  });
});

// ---------------------------------------------------------------------------
// T-PACK-VOCAB L2 — discovery backward-compat for the renamed `codexes/` dir.
// Old layout: `<scope>/codexes/<pack>/`. New layout: `<scope>/packs/<pack>/`.
// Existing users have `codexes/` on disk; discovery accepts both with a
// stderr deprecation warn for the legacy form.
// ---------------------------------------------------------------------------

async function writeValidPackInLegacyDir(name: string, scope = 'workflow'): Promise<void> {
  const packDir = join(scopeRoot, 'codexes', name);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, 'manifest.yaml'),
    [`name: ${name}`, 'version: 0.1.0', `scope: ${scope}`, 'goal: legacy fixture'].join('\n') +
      '\n',
    'utf8',
  );
}

describe('discoverActivePacks — VOCAB.1 backward-compat', () => {
  let stderrCapture: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrCapture = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      stderrCapture.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it('VOCAB.1: prefers `<scope>/packs/` when only that dir exists (no warn)', async () => {
    await writeValidPack('pack-only', 'workflow');
    await writeActive({ packs: ['pack-only'] });

    const packs = await discoverActivePacks(scopeRoot);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe('pack-only');
    expect(stderrCapture.join('')).not.toContain('deprecated');
  });

  it('VOCAB.1: falls back to legacy `<scope>/codexes/` with stderr deprecation warn', async () => {
    await writeValidPackInLegacyDir('legacy-only', 'workflow');
    await writeActive({ packs: ['legacy-only'] });

    const packs = await discoverActivePacks(scopeRoot);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe('legacy-only');
    const captured = stderrCapture.join('');
    expect(captured).toContain('codexes/');
    expect(captured).toContain('deprecated');
    expect(captured).toContain('T-PACK-VOCAB');
  });

  it('VOCAB.1: prefers `<scope>/packs/` when BOTH dirs exist (no warn; legacy ignored)', async () => {
    await writeValidPack('coexist-pack', 'workflow');
    // Same name in legacy dir — should be ignored since packs/ takes precedence
    await writeValidPackInLegacyDir('coexist-pack', 'universal');
    await writeActive({ packs: ['coexist-pack'] });

    const packs = await discoverActivePacks(scopeRoot);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.scope).toBe('workflow'); // from packs/ dir, not legacy
    expect(stderrCapture.join('')).not.toContain('deprecated');
  });
});

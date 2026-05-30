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

import type { DetectionContext } from '../runtime/detection.js';

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
// T-PACK-VOCAB L2 — discovery backward-compat for the renamed `packs/` dir.
// Old layout: `<scope>/packs/<pack>/`. New layout: `<scope>/packs/<pack>/`.
// Existing users have `packs/` on disk; discovery accepts both with a
// stderr deprecation warn for the legacy form.
// ---------------------------------------------------------------------------

async function writeValidPackInLegacyDir(name: string, scope = 'workflow'): Promise<void> {
  // Legacy dir name `codexes/` (pre-VOCAB.1) — backward-compat fallback target.
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

  it('VOCAB.1: falls back to legacy `<scope>/packs/` with stderr deprecation warn', async () => {
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

/* ────────────────────────────────────────────────────────────────────
 * IDF.3 — auto-activation pipeline: detected_by × active.json matrix.
 *
 * Validates the per-pack detected_by gate composes correctly with the
 * existing opt-in contract:
 *
 *   - opt-in: pack must be in active.json to be considered at all
 *   - detection: opted-in pack only loads if matchesDetectedBy(...) true
 *   - back-compat: ctx === null OR pack.detectedBy === [] → always loads
 *   - null ctx is the legacy behavior (existing tests above use this)
 *
 * Uses the IDF.2 DetectionContext shape; the per-pack detected_by
 * arrives via the pack's manifest.yaml (IDF.1 schema).
 * ──────────────────────────────────────────────────────────────────── */
describe('IDF.3: detected_by × active.json interaction', () => {
  /**
   * Write a manifest.yaml with an explicit `detected_by:` block.
   * Each clause is rendered as a YAML mapping where every field (after
   * `kind`) is JSON-encoded inline — JSON is a valid YAML 1.2 subset, so
   * nested `matches: {...}` round-trips through the parser unchanged.
   */
  async function writePackWithDetection(
    name: string,
    detectedBy: readonly Record<string, unknown>[],
  ): Promise<void> {
    const packDir = join(scopeRoot, 'packs', name);
    await mkdir(packDir, { recursive: true });
    const lines: string[] = [
      `name: ${name}`,
      'version: 0.1.0',
      'scope: workflow',
      'goal: idf3 fixture',
      'detected_by:',
    ];
    for (const clause of detectedBy) {
      lines.push(`  - kind: ${clause.kind as string}`);
      for (const [k, v] of Object.entries(clause)) {
        if (k === 'kind') continue;
        lines.push(`    ${k}: ${JSON.stringify(v)}`);
      }
    }
    await writeFile(join(packDir, 'manifest.yaml'), lines.join('\n') + '\n', 'utf8');
  }

  function ctxWith(overrides: Partial<DetectionContext> = {}): DetectionContext {
    return {
      cwd: '/tmp/proj',
      files: {},
      dirs: {},
      fileContents: {},
      memoryBodies: '',
      recentPrompts: '',
      userPinned: false,
      ...overrides,
    };
  }

  it('back-compat: ctx === null → all opted-in packs load regardless of detected_by', async () => {
    await writePackWithDetection('p-need-react', [
      { kind: 'file_exists', path: 'react.config.js' },
    ]);
    await writeActive({ packs: ['p-need-react'] });

    const packs = await discoverActivePacks(scopeRoot, null);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe('p-need-react');
  });

  it('back-compat: pack with empty detected_by[] (default) loads when ctx provided', async () => {
    await writeValidPack('p-no-detection');
    await writeActive({ packs: ['p-no-detection'] });

    const packs = await discoverActivePacks(scopeRoot, ctxWith());
    expect(packs).toHaveLength(1);
  });

  it('gate fires: opted-in pack with detected_by file_exists MATCHES ctx → loads', async () => {
    await writePackWithDetection('p-react-app', [{ kind: 'file_exists', path: 'package.json' }]);
    await writeActive({ packs: ['p-react-app'] });

    const packs = await discoverActivePacks(
      scopeRoot,
      ctxWith({ files: { 'package.json': true } }),
    );
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe('p-react-app');
  });

  it('gate fires: opted-in pack with detected_by does NOT match ctx → SKIPPED (dormant)', async () => {
    await writePackWithDetection('p-rust-app', [{ kind: 'file_exists', path: 'Cargo.toml' }]);
    await writeActive({ packs: ['p-rust-app'] });

    const packs = await discoverActivePacks(scopeRoot, ctxWith()); // no Cargo.toml in files
    expect(packs).toHaveLength(0);
  });

  it('opt-in invariant: pack NOT in active.json never loads even when detected_by would match', async () => {
    await writePackWithDetection('p-not-opted-in', [{ kind: 'file_exists', path: 'package.json' }]);
    await writeActive({ packs: [] });

    const packs = await discoverActivePacks(
      scopeRoot,
      ctxWith({ files: { 'package.json': true } }),
    );
    expect(packs).toHaveLength(0);
  });

  it('mixed: 3 opted-in packs — 1 matches, 1 no-detection (always-on), 1 dormant', async () => {
    await writePackWithDetection('p-react', [{ kind: 'file_exists', path: 'package.json' }]);
    await writeValidPack('p-always');
    await writePackWithDetection('p-rust', [{ kind: 'file_exists', path: 'Cargo.toml' }]);
    await writeActive({ packs: ['p-react', 'p-always', 'p-rust'] });

    const packs = await discoverActivePacks(
      scopeRoot,
      ctxWith({ files: { 'package.json': true } }),
    );
    const names = packs.map((p) => p.name).sort();
    expect(names).toEqual(['p-always', 'p-react']);
  });

  it('file_match detection: package.json deps gate the pack', async () => {
    await writePackWithDetection('p-react-19', [
      { kind: 'file_match', path: 'package.json', matches: { 'dependencies.react': '\\^19' } },
    ]);
    await writeActive({ packs: ['p-react-19'] });

    const pkgJson = JSON.stringify({ dependencies: { react: '^19.0.0' } });
    const matchingCtx = ctxWith({
      files: { 'package.json': true },
      fileContents: { 'package.json': pkgJson },
    });
    const packs = await discoverActivePacks(scopeRoot, matchingCtx);
    expect(packs).toHaveLength(1);

    const wrongVersion = JSON.stringify({ dependencies: { react: '^17.0.0' } });
    const dormantCtx = ctxWith({
      files: { 'package.json': true },
      fileContents: { 'package.json': wrongVersion },
    });
    const packs2 = await discoverActivePacks(scopeRoot, dormantCtx);
    expect(packs2).toHaveLength(0);
  });

  it('dir_exists detection: src/components/atoms presence gates the pack', async () => {
    await writePackWithDetection('p-atomic-ui', [
      { kind: 'dir_exists', path: 'src/components/atoms' },
    ]);
    await writeActive({ packs: ['p-atomic-ui'] });

    const matchingCtx = ctxWith({ dirs: { 'src/components/atoms': true } });
    const packs = await discoverActivePacks(scopeRoot, matchingCtx);
    expect(packs).toHaveLength(1);

    const dormantCtx = ctxWith();
    const packs2 = await discoverActivePacks(scopeRoot, dormantCtx);
    expect(packs2).toHaveLength(0);
  });

  it('user_pinned detection: ctx.userPinned gates the pack regardless of other context', async () => {
    await writePackWithDetection('p-pinned', [{ kind: 'user_pinned' }]);
    await writeActive({ packs: ['p-pinned'] });

    const pinnedCtx = ctxWith({ userPinned: true });
    const packs = await discoverActivePacks(scopeRoot, pinnedCtx);
    expect(packs).toHaveLength(1);

    const unpinnedCtx = ctxWith({ userPinned: false });
    const packs2 = await discoverActivePacks(scopeRoot, unpinnedCtx);
    expect(packs2).toHaveLength(0);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * MM.1 — composite pack expansion at discovery layer.
 *
 * Verifies that discoverActivePacks expands composite packs' includes
 * after per-pack loading + detected_by gating. Composites missing
 * includes throw with clear CompositeResolutionError.
 * ──────────────────────────────────────────────────────────────────── */
describe('MM.1: composite expansion at discoverActivePacks', () => {
  async function writeFocusedPack(name: string, version = '1.0.0'): Promise<void> {
    const packDir = join(scopeRoot, 'packs', name);
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, 'manifest.yaml'),
      [`name: ${name}`, `version: ${version}`, 'scope: workflow', `goal: focused ${name}`].join(
        '\n',
      ) + '\n',
      'utf8',
    );
  }

  async function writeCompositePack(
    name: string,
    includes: { pack_id: string; semver: string }[],
    version = '1.0.0',
  ): Promise<void> {
    const packDir = join(scopeRoot, 'packs', name);
    await mkdir(packDir, { recursive: true });
    const incLines = includes.flatMap((inc) => [
      `  - pack_id: ${inc.pack_id}`,
      `    semver: "${inc.semver}"`,
    ]);
    const yaml = [
      `name: ${name}`,
      `version: ${version}`,
      'scope: workflow',
      `goal: composite ${name}`,
      'kind: composite',
      'includes:',
      ...incLines,
    ].join('\n');
    await writeFile(join(packDir, 'manifest.yaml'), yaml + '\n', 'utf8');
  }

  it('composite + matching include both load (composite first, focused next)', async () => {
    await writeFocusedPack('a', '1.5.0');
    await writeCompositePack('meta', [{ pack_id: 'a', semver: '^1.0.0' }]);
    await writeActive({ packs: ['meta', 'a'] });

    const packs = await discoverActivePacks(scopeRoot, null);
    expect(packs.map((p) => p.name)).toEqual(['meta', 'a']);
  });

  it('composite references missing pack → throws CompositeResolutionError', async () => {
    await writeCompositePack('meta', [{ pack_id: 'ghost', semver: '^1.0.0' }]);
    await writeActive({ packs: ['meta'] });
    await expect(discoverActivePacks(scopeRoot, null)).rejects.toThrow(/ghost/);
  });

  it('composite with detected_by that fails → composite SKIPPED (includes also drop because composite is filtered out before expansion)', async () => {
    await writeFocusedPack('a', '1.5.0');
    // composite with detected_by that won't match
    const packDir = join(scopeRoot, 'packs', 'meta');
    await mkdir(packDir, { recursive: true });
    const yaml = [
      'name: meta',
      'version: 1.0.0',
      'scope: workflow',
      'goal: composite meta',
      'kind: composite',
      'includes:',
      '  - pack_id: a',
      '    semver: "^1.0.0"',
      'detected_by:',
      '  - kind: file_exists',
      '    path: nonexistent-marker.txt',
    ].join('\n');
    await writeFile(join(packDir, 'manifest.yaml'), yaml + '\n', 'utf8');
    await writeActive({ packs: ['meta', 'a'] });

    const ctx: DetectionContext = {
      cwd: '/tmp',
      files: {},
      dirs: {},
      fileContents: {},
      memoryBodies: '',
      recentPrompts: '',
      userPinned: false,
    };
    // meta filters out (its detected_by doesn't match); a stays (its detected_by [] matches always).
    const packs = await discoverActivePacks(scopeRoot, ctx);
    expect(packs.map((p) => p.name)).toEqual(['a']);
  });

  it('back-compat: list of only focused packs → unchanged after expansion', async () => {
    await writeFocusedPack('p1');
    await writeFocusedPack('p2');
    await writeActive({ packs: ['p1', 'p2'] });

    const packs = await discoverActivePacks(scopeRoot, null);
    expect(packs.map((p) => p.name)).toEqual(['p1', 'p2']);
  });
});

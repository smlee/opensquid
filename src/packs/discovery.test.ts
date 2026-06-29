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

import {
  _mergeCacheSize,
  checkAndMergeUpgrades,
  clearMergeCache,
  discoverActivePacks,
  readActiveExclusive,
  readActiveVerifyCommand,
  resolvePackStateDir,
  validatePackId,
} from './discovery.js';

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

describe('readActiveExclusive — project-scope isolation flag', () => {
  it('returns false when scopeRoot is null', async () => {
    await expect(readActiveExclusive(null)).resolves.toBe(false);
  });

  it('returns false when active.json is absent (ENOENT → safe default)', async () => {
    await expect(readActiveExclusive(scopeRoot)).resolves.toBe(false);
  });

  it('returns false when the exclusive key is absent (default = union)', async () => {
    await writeActive({ packs: ['fullstack-flow'] });
    await expect(readActiveExclusive(scopeRoot)).resolves.toBe(false);
  });

  it('returns true only for exclusive === true', async () => {
    await writeActive({ packs: ['fullstack-flow'], exclusive: true });
    await expect(readActiveExclusive(scopeRoot)).resolves.toBe(true);
  });

  it('returns false for an explicit exclusive: false', async () => {
    await writeActive({ packs: ['fullstack-flow'], exclusive: false });
    await expect(readActiveExclusive(scopeRoot)).resolves.toBe(false);
  });

  it('is lenient on malformed JSON (the partition read fails loud elsewhere)', async () => {
    await writeFile(join(scopeRoot, 'active.json'), '{ not json', 'utf8');
    await expect(readActiveExclusive(scopeRoot)).resolves.toBe(false);
  });
});

describe('readActiveVerifyCommand — the per-project DEPLOY verification command (DBL.1b)', () => {
  it('null scopeRoot / absent active.json / unconfigured → null (skip → deployClean:true)', async () => {
    await expect(readActiveVerifyCommand(null)).resolves.toBeNull();
    await expect(readActiveVerifyCommand(scopeRoot)).resolves.toBeNull(); // ENOENT
    await writeActive({ packs: ['fullstack-flow'] });
    await expect(readActiveVerifyCommand(scopeRoot)).resolves.toBeNull(); // key absent
  });

  it('returns the configured command verbatim', async () => {
    await writeActive({ packs: ['fullstack-flow'], verifyCommand: 'pnpm typecheck && pnpm test' });
    await expect(readActiveVerifyCommand(scopeRoot)).resolves.toBe('pnpm typecheck && pnpm test');
  });

  it('treats a blank/whitespace command as unconfigured (null)', async () => {
    await writeActive({ packs: ['fullstack-flow'], verifyCommand: '   ' });
    await expect(readActiveVerifyCommand(scopeRoot)).resolves.toBeNull();
  });

  it('is lenient on malformed JSON → null', async () => {
    await writeFile(join(scopeRoot, 'active.json'), '{ not json', 'utf8');
    await expect(readActiveVerifyCommand(scopeRoot)).resolves.toBeNull();
  });
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
// Codex→pack standardization (T-CHAT-AS-TERMINAL) — `packs/` is the sole
// pack-folder layout. The legacy `<scope>/codexes/` fallback was removed, so
// a pack that lives only under a `codexes/` dir is NOT discovered.
// ---------------------------------------------------------------------------

describe('discoverActivePacks — packs/ is the sole pack-folder layout', () => {
  it('loads packs from `<scope>/packs/`', async () => {
    await writeValidPack('pack-only', 'workflow');
    await writeActive({ packs: ['pack-only'] });

    const packs = await discoverActivePacks(scopeRoot);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.name).toBe('pack-only');
  });

  it('does NOT fall back to a legacy `<scope>/codexes/` dir', async () => {
    // A pack present only under the removed legacy dir must not be found.
    const legacyDir = join(scopeRoot, 'codexes', 'legacy-only');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, 'manifest.yaml'),
      ['name: legacy-only', 'version: 0.1.0', 'scope: workflow', 'goal: legacy fixture'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    await writeActive({ packs: ['legacy-only'] });

    await expect(discoverActivePacks(scopeRoot)).rejects.toThrow(/legacy-only/);
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

/* ────────────────────────────────────────────────────────────────────
 * LP.3 — resolvePackStateDir + validatePackId.
 * ──────────────────────────────────────────────────────────────────── */
describe('LP.3 validatePackId + resolvePackStateDir', () => {
  it('validatePackId accepts normal kebab-case ids', () => {
    expect(() => {
      validatePackId('scope-architect');
    }).not.toThrow();
    expect(() => {
      validatePackId('my-pack-v2');
    }).not.toThrow();
  });

  it('validatePackId rejects path-traversal attempts', () => {
    expect(() => {
      validatePackId('foo..bar');
    }).toThrow(/path-traversal/);
    expect(() => {
      validatePackId('foo/bar');
    }).toThrow(/path-traversal/);
    expect(() => {
      validatePackId('a\\b');
    }).toThrow(/path-traversal/);
  });

  it('validatePackId rejects leading-dot ids', () => {
    expect(() => {
      validatePackId('.hidden');
    }).toThrow(/may not start with "\."/);
  });

  it('validatePackId rejects empty id', () => {
    expect(() => {
      validatePackId('');
    }).toThrow(/empty packId/);
  });

  it('resolvePackStateDir user scope honors OPENSQUID_HOME', () => {
    const prior = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = '/tmp/oh';
    try {
      expect(resolvePackStateDir('my-pack')).toBe('/tmp/oh/packs/my-pack');
    } finally {
      if (prior === undefined) delete process.env.OPENSQUID_HOME;
      else process.env.OPENSQUID_HOME = prior;
    }
  });

  it('resolvePackStateDir project scope requires projectCwd', () => {
    expect(() => resolvePackStateDir('my-pack', 'project')).toThrow(/projectCwd required/);
    expect(resolvePackStateDir('my-pack', 'project', '/tmp/proj')).toBe(
      '/tmp/proj/.opensquid/packs/my-pack',
    );
  });

  it('resolvePackStateDir rejects malicious packIds via validatePackId', () => {
    expect(() => resolvePackStateDir('escape/here')).toThrow(/path-traversal/);
    expect(() => resolvePackStateDir('foo..bar')).toThrow(/path-traversal/);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * LP.5 — checkAndMergeUpgrades + per-session cache.
 * ──────────────────────────────────────────────────────────────────── */
describe('LP.5 checkAndMergeUpgrades', () => {
  let pStateDir: string;
  let pVanillaDir: string;

  beforeEach(async () => {
    pStateDir = await mkdtemp(join(tmpdir(), 'opensquid-lp5-state-'));
    pVanillaDir = await mkdtemp(join(tmpdir(), 'opensquid-lp5-vanilla-'));
    clearMergeCache();
  });

  afterEach(async () => {
    await rm(pStateDir, { recursive: true, force: true });
    await rm(pVanillaDir, { recursive: true, force: true });
  });

  it('returns null when pack is not installed (no version.json)', async () => {
    const r = await checkAndMergeUpgrades(pStateDir, { name: 'p', version: '1.0.0' }, pVanillaDir);
    expect(r).toBeNull();
  });

  it('returns null when personal_revision_id is 0 (no lessons to preserve)', async () => {
    const { initPersonalRevision } = await import('./personal_revision.js');
    await initPersonalRevision(pStateDir, '1.0.0');
    const r = await checkAndMergeUpgrades(pStateDir, { name: 'p', version: '2.0.0' }, pVanillaDir);
    expect(r).toBeNull();
  });

  it('returns null when vanilla === base (not an upgrade)', async () => {
    const { initPersonalRevision, appendLessonFile } = await import('./personal_revision.js');
    await initPersonalRevision(pStateDir, '1.0.0');
    await appendLessonFile(pStateDir, { rule: 'a' });
    const r = await checkAndMergeUpgrades(pStateDir, { name: 'p', version: '1.0.0' }, pVanillaDir);
    expect(r).toBeNull();
  });

  it('returns null when last_merged_vanilla equals vanilla (already merged)', async () => {
    const { initPersonalRevision, appendLessonFile, writeVersionJson, readVersionJson } =
      await import('./personal_revision.js');
    await initPersonalRevision(pStateDir, '1.0.0');
    await appendLessonFile(pStateDir, { rule: 'a' });
    const v = (await readVersionJson(pStateDir))!;
    await writeVersionJson(pStateDir, { ...v, last_merged_vanilla: '2.0.0' });
    const r = await checkAndMergeUpgrades(pStateDir, { name: 'p', version: '2.0.0' }, pVanillaDir);
    expect(r).toBeNull();
  });

  it('triggers merge when upgrade detected; subsequent calls short-circuit on last_merged_vanilla', async () => {
    const { initPersonalRevision, appendLessonFile } = await import('./personal_revision.js');
    await initPersonalRevision(pStateDir, '1.0.0');
    await appendLessonFile(pStateDir, { rule: 'a' });
    await mkdir(join(pStateDir, 'base'), { recursive: true });
    const before = _mergeCacheSize();
    const r1 = await checkAndMergeUpgrades(pStateDir, { name: 'p', version: '2.0.0' }, pVanillaDir);
    expect(r1).not.toBeNull();
    expect(_mergeCacheSize()).toBe(before + 1);
    // Second call short-circuits via last_merged_vanilla update from the first
    // merge's writeVersionJson — returns null without re-firing the merger.
    // Cache stays populated (defense against thrash within the same session
    // before persistence catches up, but the persisted check wins here).
    const r2 = await checkAndMergeUpgrades(pStateDir, { name: 'p', version: '2.0.0' }, pVanillaDir);
    expect(r2).toBeNull();
  });

  it('clearMergeCache empties the cache', async () => {
    const { initPersonalRevision, appendLessonFile } = await import('./personal_revision.js');
    await initPersonalRevision(pStateDir, '1.0.0');
    await appendLessonFile(pStateDir, { rule: 'a' });
    await mkdir(join(pStateDir, 'base'), { recursive: true });
    await checkAndMergeUpgrades(pStateDir, { name: 'p', version: '2.0.0' }, pVanillaDir);
    expect(_mergeCacheSize()).toBeGreaterThan(0);
    clearMergeCache();
    expect(_mergeCacheSize()).toBe(0);
  });
});

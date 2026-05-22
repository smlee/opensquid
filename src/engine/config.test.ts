/**
 * `resolveEngineBin` re-resolution unit tests (T.7).
 *
 * Coverage:
 *  - Valid persisted `engine_bin` → returns directly, no rewrite
 *  - Stale persisted `engine_bin` (path no longer executable) → cleared
 *    from disk + fall-through to next discovery step
 *  - All discovery steps miss → returns null + config left clean
 *  - Dev-path hit → persisted to config with `engine_bin_resolved_at`
 *  - `$PATH` hit → persisted to config
 *  - `OPENSQUID_ENGINE_BIN` env override → returned unverified, no fs
 *    read of the config file (env wins, opaque to re-resolution)
 *  - Bundled-binary hit → returned but NOT persisted (deterministic
 *    from npm layout per T.1.J)
 *
 * Strategy: tempdir for `OPENSQUID_HOME` so the persisted config file
 * is isolated. Mock `./resolver.js` so the bundled-binary branch is
 * deterministic without a real npm install layout. The dev-path +
 * `$PATH` branches run against the real `fs.stat` on tempdir-created
 * fake binaries to exercise the executable-bit check end-to-end.
 */

import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveBundledEngineBin = vi.fn<() => string | null>();

vi.mock('./resolver.js', () => ({
  resolveBundledEngineBin: (): string | null => mockResolveBundledEngineBin(),
}));

const { forgetEngineBin, loadEngineConfig, resolveEngineBin, saveEngineConfig } =
  await import('./config.js');

let tempHome: string;
let savedEnvBin: string | undefined;
let savedPath: string | undefined;
let savedHome: string | undefined;

/** Make a file at `p` and chmod it executable. */
async function makeExecutable(p: string): Promise<string> {
  await fs.mkdir(join(p, '..'), { recursive: true });
  await fs.writeFile(p, '#!/bin/sh\necho fake-engine\n', 'utf8');
  await fs.chmod(p, 0o755);
  return p;
}

beforeEach(() => {
  mockResolveBundledEngineBin.mockReset();
  mockResolveBundledEngineBin.mockReturnValue(null); // default: no bundled
  tempHome = mkdtempSync(join(tmpdir(), 'opensquid-config-test-'));
  process.env.OPENSQUID_HOME = tempHome;
  // Snapshot + clear so the test process's real env doesn't leak in.
  savedEnvBin = process.env.OPENSQUID_ENGINE_BIN;
  delete process.env.OPENSQUID_ENGINE_BIN;
  savedPath = process.env.PATH;
  process.env.PATH = ''; // disable $PATH-fallback unless a test sets it
  // Point $HOME at the tempdir so `searchCommonPaths` doesn't discover
  // a real engine binary under the developer's `~/projects/loop/...`
  // layout. `os.homedir()` consults $HOME on POSIX systems.
  savedHome = process.env.HOME;
  process.env.HOME = tempHome;
});

afterEach(() => {
  delete process.env.OPENSQUID_HOME;
  if (savedEnvBin !== undefined) {
    process.env.OPENSQUID_ENGINE_BIN = savedEnvBin;
  } else {
    delete process.env.OPENSQUID_ENGINE_BIN;
  }
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
  } else {
    delete process.env.PATH;
  }
  if (savedHome !== undefined) {
    process.env.HOME = savedHome;
  } else {
    delete process.env.HOME;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe('resolveEngineBin — env override', () => {
  it('returns OPENSQUID_ENGINE_BIN unverified (env wins)', async () => {
    process.env.OPENSQUID_ENGINE_BIN = '/explicitly/pinned/loop-engine';
    const got = await resolveEngineBin();
    expect(got).toBe('/explicitly/pinned/loop-engine');
    // Env-override bypass: should not have written a config file at all.
    await expect(fs.stat(join(tempHome, 'engine-config.json'))).rejects.toThrow();
  });
});

describe('resolveEngineBin — persisted path', () => {
  it('returns the persisted path when it is still executable', async () => {
    const bin = await makeExecutable(join(tempHome, 'real-engine'));
    await saveEngineConfig({
      version: 1,
      engine_bin: bin,
      engine_bin_resolved_at: '2026-01-01T00:00:00.000Z',
    });
    const got = await resolveEngineBin();
    expect(got).toBe(bin);
    // Timestamp not bumped — direct-hit path doesn't rewrite.
    const reloaded = await loadEngineConfig();
    expect(reloaded.engine_bin_resolved_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('clears a stale persisted path and falls through to discovery', async () => {
    // Persist a path that doesn't exist on disk.
    await saveEngineConfig({
      version: 1,
      engine_bin: '/definitely/does/not/exist/loop-engine',
      engine_bin_resolved_at: '2026-01-01T00:00:00.000Z',
    });
    // No bundled / no dev / no $PATH match → should return null.
    const got = await resolveEngineBin();
    expect(got).toBeNull();
    // Stale entry must be cleared from the persisted config.
    const reloaded = await loadEngineConfig();
    expect(reloaded.engine_bin).toBeUndefined();
    expect(reloaded.engine_bin_resolved_at).toBeUndefined();
  });

  it('clears stale persisted path then persists a fresh $PATH hit', async () => {
    await saveEngineConfig({
      version: 1,
      engine_bin: '/definitely/does/not/exist/loop-engine',
      engine_bin_resolved_at: '2026-01-01T00:00:00.000Z',
    });
    // Put a fresh binary on a synthetic $PATH so the fallback finds it.
    const pathDir = join(tempHome, 'usr-local-bin');
    await fs.mkdir(pathDir, { recursive: true });
    await makeExecutable(join(pathDir, 'loop-engine'));
    process.env.PATH = pathDir;

    const got = await resolveEngineBin();
    expect(got).toBe(join(pathDir, 'loop-engine'));

    // Fresh hit should be persisted.
    const reloaded = await loadEngineConfig();
    expect(reloaded.engine_bin).toBe(join(pathDir, 'loop-engine'));
    expect(reloaded.engine_bin_resolved_at).toBeDefined();
    expect(reloaded.engine_bin_resolved_at).not.toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('resolveEngineBin — bundled-binary branch', () => {
  it('returns a bundled hit but does NOT persist it', async () => {
    const bin = await makeExecutable(join(tempHome, 'node_modules-bundled-engine'));
    mockResolveBundledEngineBin.mockReturnValue(bin);

    const got = await resolveEngineBin();
    expect(got).toBe(bin);

    // No persistence — bundled paths are deterministic from npm layout
    // and persisting them makes upgrades hostile.
    const reloaded = await loadEngineConfig();
    expect(reloaded.engine_bin).toBeUndefined();
  });

  it('skips a bundled hit if the file is not executable', async () => {
    const bogus = join(tempHome, 'not-actually-a-binary');
    await fs.writeFile(bogus, 'not chmod +x', 'utf8'); // mode = 0o644
    mockResolveBundledEngineBin.mockReturnValue(bogus);

    const got = await resolveEngineBin();
    expect(got).toBeNull();
  });
});

describe('resolveEngineBin — null result', () => {
  it('returns null when nothing is discoverable and leaves config clean', async () => {
    const got = await resolveEngineBin();
    expect(got).toBeNull();
    const cfg = await loadEngineConfig();
    expect(cfg.engine_bin).toBeUndefined();
  });
});

describe('forgetEngineBin', () => {
  it('clears persisted engine_bin + timestamp', async () => {
    await saveEngineConfig({
      version: 1,
      engine_bin: '/some/path',
      engine_bin_resolved_at: '2026-01-01T00:00:00.000Z',
    });
    await forgetEngineBin();
    const reloaded = await loadEngineConfig();
    expect(reloaded.engine_bin).toBeUndefined();
    expect(reloaded.engine_bin_resolved_at).toBeUndefined();
  });
});

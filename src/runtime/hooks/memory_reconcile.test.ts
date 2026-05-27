/**
 * Tests for `reconcileMemoryOnSessionEnd` (MAU.3).
 *
 * Uses injected deps (readCwd, autoMemoryRoot, engineFactory, opensquidHome,
 * stderr) so every branch is exercised without a live engine or the real
 * ~/.claude tree. The engine-throws case is the fail-loud anchor: the function
 * must surface the failure on stderr and RESOLVE (never throw / block session
 * end).
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineClient } from '../../engine/client.js';

import { encodeProjectPath, reconcileMemoryOnSessionEnd } from './memory_reconcile.js';

let root: string; // stands in for ~/.claude/projects
let home: string; // stands in for OPENSQUID_HOME

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mau3-root-'));
  home = await mkdtemp(join(tmpdir(), 'mau3-home-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** A stub engine whose snapshot-relevant methods resolve to empty results. */
function okEngine(): { client: EngineClient; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn().mockResolvedValue(undefined);
  // snapshotAuto reads memoryList (→ empty) + writes the timestamp; with an
  // empty auto-memory dir it makes no create/update calls.
  const memoryList = vi
    .fn()
    .mockResolvedValue({ total: 0, limit: 200, offset: 0, returned: 0, results: [] });
  const client = { memoryList, close } as unknown as EngineClient;
  return { client, close };
}

const collectStderr = (): { write: (s: string) => void; text: () => string } => {
  let buf = '';
  return { write: (s: string) => void (buf += s), text: () => buf };
};

describe('encodeProjectPath', () => {
  it('replaces every / with - (matches Claude Code auto-memory dir naming)', () => {
    expect(encodeProjectPath('/Users/x/projects/loop')).toBe('-Users-x-projects-loop');
  });
});

describe('reconcileMemoryOnSessionEnd', () => {
  it('skips (no engine) when no cwd was recorded', async () => {
    const engineFactory = vi.fn();
    await reconcileMemoryOnSessionEnd('s', {
      readCwd: () => Promise.resolve(null),
      autoMemoryRoot: root,
      engineFactory: engineFactory as unknown as () => EngineClient,
      opensquidHome: () => home,
      stderr: vi.fn(),
    });
    expect(engineFactory).not.toHaveBeenCalled();
  });

  it('skips (no engine) when the project auto-memory dir does not exist', async () => {
    const engineFactory = vi.fn();
    await reconcileMemoryOnSessionEnd('s', {
      readCwd: () => Promise.resolve('/Users/x/projects/loop'), // no matching dir under root
      autoMemoryRoot: root,
      engineFactory: engineFactory as unknown as () => EngineClient,
      opensquidHome: () => home,
      stderr: vi.fn(),
    });
    expect(engineFactory).not.toHaveBeenCalled();
  });

  it('runs snapshotAuto when the auto-memory dir exists (happy path)', async () => {
    const cwd = '/Users/x/projects/loop';
    await mkdir(join(root, encodeProjectPath(cwd), 'memory'), { recursive: true });
    const { client, close } = okEngine();
    const engineFactory = vi.fn(() => client);
    const errs = collectStderr();
    await reconcileMemoryOnSessionEnd('s', {
      readCwd: () => Promise.resolve(cwd),
      autoMemoryRoot: root,
      engineFactory,
      opensquidHome: () => home,
      stderr: errs.write,
    });
    expect(engineFactory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1); // engine closed in finally
    expect(errs.text()).toMatch(/memory reconcile — imported \d+, refreshed \d+, skipped \d+/);
  });

  it('FAILS LOUD but does not throw when the engine errors', async () => {
    const cwd = '/Users/x/projects/loop';
    await mkdir(join(root, encodeProjectPath(cwd), 'memory'), { recursive: true });
    const engineFactory = vi.fn(() => {
      throw new Error('engine down');
    });
    const errs = collectStderr();
    // Must RESOLVE (no throw) — session end is never blocked.
    await expect(
      reconcileMemoryOnSessionEnd('s', {
        readCwd: () => Promise.resolve(cwd),
        autoMemoryRoot: root,
        engineFactory: engineFactory as unknown as () => EngineClient,
        opensquidHome: () => home,
        stderr: errs.write,
      }),
    ).resolves.toBeUndefined();
    expect(errs.text()).toMatch(/memory reconcile FAILED/);
  });
});

/**
 * Tests for `reconcileMemoryOnSessionEnd` (MAU.3, retire-Rust RES-5b). Injected deps (readCwd,
 * autoMemoryRoot, storeFactory, opensquidHome, stderr) exercise every branch without a live store or
 * the real ~/.claude tree. The store-throws case is the fail-loud anchor: the function surfaces the
 * failure on stderr and RESOLVES (never throws / blocks session end).
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryStore } from '../../setup/migrate/memory_store_handle.js';

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

/** A stub MemoryStore. `index` is what listImportIndex returns; close is recorded. */
function okStore(index = new Map<string, { id: string }>()): {
  store: MemoryStore;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn().mockResolvedValue(undefined);
  const store = {
    listImportIndex: vi.fn().mockResolvedValue(index),
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    close,
  } as unknown as MemoryStore;
  return { store, close };
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
  it('skips (no store) when no cwd was recorded', async () => {
    const storeFactory = vi.fn();
    await reconcileMemoryOnSessionEnd('s', {
      readCwd: () => Promise.resolve(null),
      autoMemoryRoot: root,
      storeFactory: storeFactory as unknown as () => Promise<MemoryStore>,
      opensquidHome: () => home,
      stderr: vi.fn(),
    });
    expect(storeFactory).not.toHaveBeenCalled();
  });

  it('skips (no store) when the project auto-memory dir does not exist', async () => {
    const storeFactory = vi.fn();
    await reconcileMemoryOnSessionEnd('s', {
      readCwd: () => Promise.resolve('/Users/x/projects/loop'),
      autoMemoryRoot: root,
      storeFactory: storeFactory as unknown as () => Promise<MemoryStore>,
      opensquidHome: () => home,
      stderr: vi.fn(),
    });
    expect(storeFactory).not.toHaveBeenCalled();
  });

  it('runs snapshotAuto when the auto-memory dir exists (happy path)', async () => {
    const cwd = '/Users/x/projects/loop';
    await mkdir(join(root, encodeProjectPath(cwd), 'memory'), { recursive: true });
    const { store, close } = okStore();
    const storeFactory = vi.fn(() => Promise.resolve(store));
    const errs = collectStderr();
    await reconcileMemoryOnSessionEnd('s', {
      readCwd: () => Promise.resolve(cwd),
      autoMemoryRoot: root,
      storeFactory,
      opensquidHome: () => home,
      stderr: errs.write,
    });
    expect(storeFactory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1); // store closed in finally
    expect(errs.text()).toMatch(/memory reconcile — imported \d+, refreshed \d+, skipped \d+/);
  });

  it('FAILS LOUD but does not throw when the store errors', async () => {
    const cwd = '/Users/x/projects/loop';
    await mkdir(join(root, encodeProjectPath(cwd), 'memory'), { recursive: true });
    const storeFactory = vi.fn(() => {
      throw new Error('store down');
    });
    const errs = collectStderr();
    await expect(
      reconcileMemoryOnSessionEnd('s', {
        readCwd: () => Promise.resolve(cwd),
        autoMemoryRoot: root,
        storeFactory: storeFactory as unknown as () => Promise<MemoryStore>,
        opensquidHome: () => home,
        stderr: errs.write,
      }),
    ).resolves.toBeUndefined();
    expect(errs.text()).toMatch(/memory reconcile FAILED/);
  });

  // MF.1 (H1): the loud self-audit AFTER reconcile. An empty disk dir but an import-marked store
  // entry whose source .md is gone → the post-reconcile drift check sees an ORPHAN, surfaced loudly.
  it('surfaces a NON-empty post-reconcile drift LOUDLY (orphaned import entry)', async () => {
    const cwd = '/Users/x/projects/loop';
    await mkdir(join(root, encodeProjectPath(cwd), 'memory'), { recursive: true }); // empty dir
    const { store, close } = okStore(new Map([['gone', { id: 'id-gone' }]]));
    const errs = collectStderr();
    await reconcileMemoryOnSessionEnd('s', {
      readCwd: () => Promise.resolve(cwd),
      autoMemoryRoot: root,
      storeFactory: () => Promise.resolve(store),
      opensquidHome: () => home,
      stderr: errs.write,
    });
    expect(errs.text()).toMatch(/post-reconcile drift/);
    expect(errs.text()).toMatch(/orphaned/);
    expect(close).toHaveBeenCalledTimes(1); // store still closed once (finally)
  });
});

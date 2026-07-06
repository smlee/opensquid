/**
 * CAT.5.1 — agent-bridge headless-responder autospawn unit tests.
 *
 * Mirrors `src/channels/daemon/autospawn.test.ts`: we deliberately NEVER spawn a
 * real daemon — every test injects the `isConfigured` / `statusFn` / `spawnFn` /
 * `resolveProjectUuidFn` / `resolvePackRootFn` seams so the autospawn FSM is
 * exercised in full without reading the developer's real chat config or
 * launching a process. The lock/pidfile side-files are isolated via
 * OPENSQUID_HOME → mkdtemp (the lock path is real fs, driven by tryAcquireLock).
 */

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GENERAL_UMBRELLA } from '../../channels/routing.js';

import { agentBridgeLockPath } from './daemon.js';

import {
  ensureAgentBridgeRunning,
  ensureHeadlessRespondersForBoot,
  resolveCliEntrypoint,
} from './autospawn.js';

const GENERAL_SCOPE = { umbrellaId: GENERAL_UMBRELLA };

describe('agent-bridge autospawn', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedEntry: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.OPENSQUID_HOME;
    savedEntry = process.env.OPENSQUID_CLI_ENTRYPOINT;
    home = await mkdtemp(join(tmpdir(), 'cat51-autospawn-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = savedHome;
    if (savedEntry === undefined) delete process.env.OPENSQUID_CLI_ENTRYPOINT;
    else process.env.OPENSQUID_CLI_ENTRYPOINT = savedEntry;
    await rm(home, { recursive: true, force: true });
  });

  // — no_config —————————————————————————————————————————————————————————————

  it('is a no-op when no chat platform is configured (no status/spawn calls)', async () => {
    const statusFn = vi.fn();
    const spawnFn = vi.fn();
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(false),
        statusFn: statusFn as never,
        spawnFn: spawnFn as never,
      },
    );
    expect(res).toEqual({ status: 'no_config' });
    expect(statusFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('umbrella skips (no_config) when the project uuid is unresolvable — before any lock/status', async () => {
    const statusFn = vi.fn();
    const spawnFn = vi.fn();
    const res = await ensureAgentBridgeRunning(
      { kind: 'umbrella', umbrellaId: 'loop', cwd: '/work/loop' },
      {
        isConfigured: () => Promise.resolve(true),
        resolveProjectUuidFn: () => Promise.resolve(null),
        statusFn: statusFn as never,
        spawnFn: spawnFn as never,
      },
    );
    expect(res).toEqual({ status: 'no_config' });
    expect(statusFn).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  // — already_running ————————————————————————————————————————————————————————

  it('returns already_running without spawning when the scoped daemon is up', async () => {
    const spawnFn = vi.fn();
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(true),
        statusFn: () => Promise.resolve({ running: true, pid: 4242 }),
        spawnFn: spawnFn as never,
      },
    );
    expect(res).toEqual({ status: 'already_running', pid: 4242 });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('returns already_running (no spawn) when a peer wins the double-check after the lock', async () => {
    // First status probe (pre-lock) sees nothing; the re-check inside the lock
    // finds a peer that raced us to the pidfile → stand down, do not spawn.
    let calls = 0;
    const statusFn = vi.fn(() =>
      Promise.resolve(++calls === 1 ? { running: false } : { running: true, pid: 909 }),
    );
    const spawnFn = vi.fn();
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(true),
        statusFn: statusFn,
        spawnFn: spawnFn as never,
        entrypoint: '/x/dist/cli.js',
      },
    );
    expect(res).toEqual({ status: 'already_running', pid: 909 });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(statusFn).toHaveBeenCalledTimes(2);
  });

  // — spawned ————————————————————————————————————————————————————————————————

  it('spawns the general responder when configured + not running (args include --general)', async () => {
    const spawnFn = vi.fn(() => ({ pid: 999 }));
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(true),
        statusFn: () => Promise.resolve({ running: false }),
        spawnFn,
        entrypoint: '/x/dist/cli.js',
        env: { FOO: 'bar' },
      },
    );
    expect(res).toEqual({ status: 'spawned', pid: 999 });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith('/x/dist/cli.js', {
      args: ['agent-bridge', 'start', '--general'],
      env: { FOO: 'bar' },
    });
  });

  it('spawns the umbrella responder, injecting resolved project uuid + pack root into the child env', async () => {
    const spawnFn = vi.fn(() => ({ pid: 1234 }));
    const res = await ensureAgentBridgeRunning(
      { kind: 'umbrella', umbrellaId: 'loop', cwd: '/work/loop' },
      {
        isConfigured: () => Promise.resolve(true),
        resolveProjectUuidFn: () => Promise.resolve('proj-abc'),
        resolvePackRootFn: () => '/packs/root',
        statusFn: () => Promise.resolve({ running: false }),
        spawnFn,
        entrypoint: '/x/dist/cli.js',
        env: { FOO: 'bar' },
      },
    );
    expect(res).toEqual({ status: 'spawned', pid: 1234 });
    expect(spawnFn).toHaveBeenCalledWith('/x/dist/cli.js', {
      args: ['agent-bridge', 'start'],
      env: {
        FOO: 'bar',
        OPENSQUID_PROJECT_UUID: 'proj-abc',
        OPENSQUID_PACK_ROOT: '/packs/root',
      },
    });
  });

  it('reports spawned with no pid when the spawn yields no child pid', async () => {
    const spawnFn = vi.fn(() => ({}));
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(true),
        statusFn: () => Promise.resolve({ running: false }),
        spawnFn,
        entrypoint: '/x/dist/cli.js',
      },
    );
    expect(res).toEqual({ status: 'spawned' });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  // — waited_for_peer ————————————————————————————————————————————————————————

  it('waits for a peer when another process holds a fresh lock (waited_for_peer)', async () => {
    // Pre-create a FRESH lock so tryAcquireLock loses (EEXIST, not stale); the
    // peer's pidfile then appears on the next status poll.
    await writeFile(agentBridgeLockPath(GENERAL_SCOPE), '4321\n');
    let calls = 0;
    const statusFn = vi.fn(() =>
      Promise.resolve(++calls === 1 ? { running: false } : { running: true, pid: 555 }),
    );
    const spawnFn = vi.fn();
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(true),
        statusFn: statusFn,
        spawnFn: spawnFn as never,
        entrypoint: '/x/dist/cli.js',
      },
    );
    expect(res).toEqual({ status: 'waited_for_peer', pid: 555 });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  // — stale-lock reclaim —————————————————————————————————————————————————————

  it('reclaims a stale lock (> 15s old) and spawns', async () => {
    // Pre-create a STALE lock (mtime 20s ago) — tryAcquireLock must reclaim it,
    // re-open 'wx', and proceed to spawn. If reclaim failed we would fall into
    // the peer-wait path and spawnFn would not be called.
    const lockPath = agentBridgeLockPath(GENERAL_SCOPE);
    await writeFile(lockPath, '4321\n');
    const stale = new Date(Date.now() - 20_000);
    await utimes(lockPath, stale, stale);
    const spawnFn = vi.fn(() => ({ pid: 321 }));
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(true),
        statusFn: () => Promise.resolve({ running: false }),
        spawnFn,
        entrypoint: '/x/dist/cli.js',
      },
    );
    expect(res).toEqual({ status: 'spawned', pid: 321 });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  // — never throws ———————————————————————————————————————————————————————————

  it('never throws — a rejecting isConfigured becomes { status: "error" }', async () => {
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      { isConfigured: () => Promise.reject(new Error('boom')) },
    );
    expect(res.status).toBe('error');
    expect(res.error).toContain('boom');
  });

  it('never throws — a throwing spawnFn becomes { status: "error" } (lock still released)', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn kaboom');
    });
    const res = await ensureAgentBridgeRunning(
      { kind: 'general' },
      {
        isConfigured: () => Promise.resolve(true),
        statusFn: () => Promise.resolve({ running: false }),
        spawnFn,
        entrypoint: '/x/dist/cli.js',
      },
    );
    expect(res.status).toBe('error');
    expect(res.error).toContain('spawn kaboom');
  });

  // — resolveCliEntrypoint ———————————————————————————————————————————————————

  it('resolveCliEntrypoint honors OPENSQUID_CLI_ENTRYPOINT', () => {
    process.env.OPENSQUID_CLI_ENTRYPOINT = '/custom/cli.js';
    expect(resolveCliEntrypoint()).toBe('/custom/cli.js');
  });

  it('resolveCliEntrypoint defaults to a dist/cli.js path', () => {
    delete process.env.OPENSQUID_CLI_ENTRYPOINT;
    expect(resolveCliEntrypoint()).toMatch(/cli\.js$/);
  });

  // — ensureHeadlessRespondersForBoot (umbrella-skip orchestration) ——————————

  it('boot ensures only the general responder when there is no umbrella (umbrella result null)', async () => {
    const ensureFn = vi.fn(() => Promise.resolve({ status: 'spawned' as const, pid: 1 }));
    const out = await ensureHeadlessRespondersForBoot({
      umbrellaForCwd: null,
      ensureFn: ensureFn,
    });
    expect(out).toEqual({ general: { status: 'spawned', pid: 1 }, umbrella: null });
    expect(ensureFn).toHaveBeenCalledTimes(1);
    expect(ensureFn).toHaveBeenCalledWith({ kind: 'general' }, undefined);
  });

  it('boot skips the umbrella responder when the cwd resolves to the general umbrella', async () => {
    const ensureFn = vi.fn(() => Promise.resolve({ status: 'no_config' as const }));
    const out = await ensureHeadlessRespondersForBoot({
      umbrellaForCwd: GENERAL_UMBRELLA,
      ensureFn: ensureFn,
    });
    expect(out.umbrella).toBeNull();
    expect(ensureFn).toHaveBeenCalledTimes(1);
    expect(ensureFn).toHaveBeenCalledWith({ kind: 'general' }, undefined);
  });

  it('boot ensures both general and the project umbrella responder when the cwd resolves to one', async () => {
    let n = 0;
    const ensureFn = vi.fn(() =>
      Promise.resolve(
        ++n === 1
          ? { status: 'spawned' as const, pid: 10 }
          : { status: 'already_running' as const, pid: 20 },
      ),
    );
    const out = await ensureHeadlessRespondersForBoot({
      umbrellaForCwd: 'loop',
      cwd: '/work/loop',
      ensureFn: ensureFn,
    });
    expect(out).toEqual({
      general: { status: 'spawned', pid: 10 },
      umbrella: { status: 'already_running', pid: 20 },
    });
    expect(ensureFn).toHaveBeenCalledTimes(2);
    expect(ensureFn).toHaveBeenNthCalledWith(1, { kind: 'general' }, undefined);
    expect(ensureFn).toHaveBeenNthCalledWith(
      2,
      { kind: 'umbrella', umbrellaId: 'loop', cwd: '/work/loop' },
      undefined,
    );
  });
});

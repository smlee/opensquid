/**
 * ATL.4 — loop autospawn unit tests (T-auto-trigger-loop-on-scope-exit).
 *
 * We deliberately NEVER spawn a real loop (the testing lens forbids coupling to a live process) — every FSM
 * test injects `statusFn` / `startFn` seams so the idempotent / single-flight / fail-open behavior is exercised
 * in full without launching `dist/cli.js loop` or writing the developer's real `.opensquid/`. Filesystem is
 * isolated via `OPENSQUID_PROJECT_ROOT` → mkdtemp (the project-local analog of the chat-daemon's OPENSQUID_HOME
 * seam). `loopStatus` + the path helpers read only a temp-dir pidfile the test controls.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loopPidPath, loopLockPath } from '../paths.js';

import {
  ensureLoopRunning,
  loopStatus,
  resolveLoopEntrypoint,
  type LoopStatus,
} from './loop_autospawn.js';

const running = (pid: number): Promise<LoopStatus> =>
  Promise.resolve({ running: true, pid, uptime_ms: 1 });
const notRunning = (): Promise<LoopStatus> => Promise.resolve({ running: false });

describe('loop autospawn — ensureLoopRunning FSM (injected seams, no live spawn)', () => {
  let root: string;
  let priorRoot: string | undefined;

  beforeEach(async () => {
    priorRoot = process.env.OPENSQUID_PROJECT_ROOT;
    root = await mkdtemp(join(tmpdir(), 'atl-autospawn-'));
    process.env.OPENSQUID_PROJECT_ROOT = root; // resolveLocalStoreDir → <root>/.opensquid
  });
  afterEach(async () => {
    if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('already-running → { already_running } and NO spawn (idempotent)', async () => {
    const startFn = vi.fn();
    const res = await ensureLoopRunning('/proj', {
      statusFn: () => running(42),
      startFn: startFn as never,
    });
    expect(res).toEqual({ status: 'already_running', pid: 42 });
    expect(startFn).not.toHaveBeenCalled();
  });

  it('not-running → exactly one spawn', async () => {
    const startFn = vi.fn().mockResolvedValue({ pid: 99 });
    const res = await ensureLoopRunning('/proj', {
      statusFn: notRunning,
      startFn: startFn as never,
    });
    expect(res).toEqual({ status: 'spawned', pid: 99 });
    expect(startFn).toHaveBeenCalledTimes(1);
  });

  it('a spawn fault → { status: "error" }, never throws (fail-open)', async () => {
    const res = await ensureLoopRunning('/proj', {
      statusFn: notRunning,
      startFn: () => Promise.reject(new Error('boom')),
    });
    expect(res.status).toBe('error');
    expect(res.error).toContain('boom');
  });

  it('two concurrent callers spawn AT MOST one loop (single-flight lock)', async () => {
    // Shared real lock dir (the temp OPENSQUID_PROJECT_ROOT). The injected statusFn flips to running only AFTER
    // the first startFn resolves, so the lock-loser's waitForPeer observes the peer and does not double-spawn.
    let started = 0;
    let up = false;
    const statusFn = (): Promise<LoopStatus> => (up ? running(777) : notRunning());
    const startFn = vi.fn((): Promise<{ pid: number }> => {
      started += 1;
      up = true;
      return Promise.resolve({ pid: 777 });
    });
    const [a, b] = await Promise.all([
      ensureLoopRunning('/proj', { statusFn, startFn }),
      ensureLoopRunning('/proj', { statusFn, startFn }),
    ]);
    expect(started).toBe(1); // exactly ONE spawn across both callers
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain('spawned');
    expect(statuses).toContain('waited_for_peer'); // the loser waited for the winner's pidfile
  });

  it('resolveLocalStoreDir throwing (no project store) → { status: "error" }, never throws (fail-open)', async () => {
    delete process.env.OPENSQUID_PROJECT_ROOT; // no override → walk up from a store-less temp dir → throw
    const bare = await mkdtemp(join(tmpdir(), 'atl-noproj-'));
    try {
      const res = await ensureLoopRunning(bare); // NO deps: the real resolveLocalStoreDir runs and throws
      expect(res.status).toBe('error');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('loop autospawn — loopStatus (project-local pidfile liveness)', () => {
  let store: string;
  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), 'atl-status-'));
  });
  afterEach(async () => {
    await rm(store, { recursive: true, force: true });
  });

  it('missing pidfile → { running: false }', async () => {
    expect(await loopStatus(store)).toEqual({ running: false });
  });

  it('pidfile with a live pid (this process) → { running: true }', async () => {
    await writeFile(loopPidPath(store), `${process.pid}\n`);
    const st = await loopStatus(store);
    expect(st.running).toBe(true);
    if (st.running) expect(st.pid).toBe(process.pid);
  });

  it('pidfile with a dead pid → { running: false, stale_pid }', async () => {
    const deadPid = 2_147_483_646; // astronomically unlikely to be live
    await writeFile(loopPidPath(store), `${deadPid}\n`);
    expect(await loopStatus(store)).toEqual({ running: false, stale_pid: deadPid });
  });

  it('pidfile with garbage → { running: false }', async () => {
    await writeFile(loopPidPath(store), 'not-a-pid\n');
    expect(await loopStatus(store)).toEqual({ running: false });
  });
});

describe('loop autospawn — path helpers + entrypoint (data-shape)', () => {
  it('loopPidPath/loopLockPath resolve UNDER the passed project store dir', () => {
    expect(loopPidPath('/x/.opensquid')).toBe('/x/.opensquid/loop.pid');
    expect(loopLockPath('/x/.opensquid')).toBe('/x/.opensquid/loop.spawn.lock');
  });

  it('resolveLoopEntrypoint honors OPENSQUID_CLI_ENTRYPOINT, else defaults to a dist/cli.js path', () => {
    const prior = process.env.OPENSQUID_CLI_ENTRYPOINT;
    try {
      process.env.OPENSQUID_CLI_ENTRYPOINT = '/custom/cli.js';
      expect(resolveLoopEntrypoint()).toBe('/custom/cli.js');
      delete process.env.OPENSQUID_CLI_ENTRYPOINT;
      expect(resolveLoopEntrypoint()).toMatch(/cli\.js$/);
    } finally {
      if (prior === undefined) delete process.env.OPENSQUID_CLI_ENTRYPOINT;
      else process.env.OPENSQUID_CLI_ENTRYPOINT = prior;
    }
  });

  it('the module carries NO stage vocabulary (generic loop-trigger — ask Boundary)', () => {
    // Stage-blindness is a contract: the mechanism must not reference the fullstack-flow stage names as literals.
    // Asserted against the module's own source so the guarantee travels with the suite (not an external grep).
    const here = fileURLToPath(import.meta.url);
    const src = readFileSync(join(dirname(here), 'loop_autospawn.ts'), 'utf8');
    for (const stage of ['author', 'plan', 'deploy']) {
      expect(src.includes(`'${stage}'`)).toBe(false);
      expect(src.includes(`"${stage}"`)).toBe(false);
    }
  });
});

/**
 * CAT.1d — chat-daemon autospawn unit tests.
 *
 * We deliberately NEVER spawn a real daemon (the task forbids touching a live
 * daemon) — every test injects `isConfigured` / `statusFn` / `startFn` seams so
 * the FSM is exercised in full without reading the developer's real chat config
 * or launching a process. fs/home is isolated via OPENSQUID_HOME → mkdtemp.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureChatDaemonRunning, resolveCliEntrypoint } from './autospawn.js';

describe('chat-daemon autospawn', () => {
  let home: string;
  let savedHome: string | undefined;
  let savedEntry: string | undefined;

  beforeEach(async () => {
    savedHome = process.env.OPENSQUID_HOME;
    savedEntry = process.env.OPENSQUID_CLI_ENTRYPOINT;
    home = await mkdtemp(join(tmpdir(), 'cat1d-autospawn-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = savedHome;
    if (savedEntry === undefined) delete process.env.OPENSQUID_CLI_ENTRYPOINT;
    else process.env.OPENSQUID_CLI_ENTRYPOINT = savedEntry;
    await rm(home, { recursive: true, force: true });
  });

  it('is a no-op when no chat platform is configured (no status/start calls)', async () => {
    const statusFn = vi.fn();
    const startFn = vi.fn();
    const res = await ensureChatDaemonRunning({
      isConfigured: () => Promise.resolve(false),
      statusFn: statusFn as never,
      startFn: startFn as never,
    });
    expect(res.status).toBe('no_config');
    expect(statusFn).not.toHaveBeenCalled();
    expect(startFn).not.toHaveBeenCalled();
  });

  it('returns already_running without spawning when a daemon is up', async () => {
    const startFn = vi.fn();
    const res = await ensureChatDaemonRunning({
      isConfigured: () => Promise.resolve(true),
      statusFn: () => Promise.resolve({ running: true, pid: 4242, uptime_ms: 1000 }),
      startFn: startFn as never,
    });
    expect(res).toEqual({ status: 'already_running', pid: 4242 });
    expect(startFn).not.toHaveBeenCalled();
  });

  it('spawns when configured + not running, threading the resolved entrypoint', async () => {
    const startFn = vi.fn().mockResolvedValue({ already_running: false, pid: 999 });
    const res = await ensureChatDaemonRunning({
      isConfigured: () => Promise.resolve(true),
      statusFn: () => Promise.resolve({ running: false }),
      startFn: startFn as never,
      entrypoint: '/x/dist/cli.js',
    });
    expect(res).toEqual({ status: 'spawned', pid: 999 });
    expect(startFn).toHaveBeenCalledWith({ entrypoint: '/x/dist/cli.js' });
  });

  it('never throws — a startFn rejection becomes { status: "error" }', async () => {
    const res = await ensureChatDaemonRunning({
      isConfigured: () => Promise.resolve(true),
      statusFn: () => Promise.resolve({ running: false }),
      startFn: () => Promise.reject(new Error('boom')),
    });
    expect(res.status).toBe('error');
    expect(res.error).toContain('boom');
  });

  it('resolveCliEntrypoint honors OPENSQUID_CLI_ENTRYPOINT', () => {
    process.env.OPENSQUID_CLI_ENTRYPOINT = '/custom/cli.js';
    expect(resolveCliEntrypoint()).toBe('/custom/cli.js');
  });

  it('resolveCliEntrypoint defaults to a dist/cli.js path', () => {
    delete process.env.OPENSQUID_CLI_ENTRYPOINT;
    expect(resolveCliEntrypoint()).toMatch(/cli\.js$/);
  });
});

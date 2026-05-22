/**
 * `opensquid engine kill` CLI unit tests (T.7).
 *
 * Coverage:
 *  - No pidfile + no socket → friendly "no engine daemon running." + exit 0
 *  - Valid pidfile → SIGTERM sent, 2s grace wait, socket + pidfile cleaned
 *  - Stale pidfile (pid no longer alive, ESRCH) → cleanup still runs
 *  - Malformed pidfile (non-numeric) → warn + cleanup still runs
 *  - Missing pidfile but stale socket → cleanup runs, no SIGTERM attempted
 *
 * Strategy: tempdir for `OPENSQUID_HOME` so the pid + socket paths
 * are isolated. Mock `process.kill` so we don't actually signal random
 * pids on the dev machine. Fake the timer so the 2s grace wait
 * doesn't slow the suite.
 *
 * Note: we directly drive `registerEngineCli`'s `kill` handler via
 * commander rather than re-exporting `cmdKill`. Keeps the test against
 * the public surface (the wired-up subcommand), not an internal.
 */

import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { registerEngineCli } from './cli.js';

let tempHome: string;
let savedEnvBin: string | undefined;
let stdoutCapture: string;
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let killSpy: MockInstance<typeof process.kill>;

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit so tests can catch
  registerEngineCli(program);
  return program;
}

async function runKill(): Promise<void> {
  const program = makeProgram();
  await program.parseAsync(['node', 'opensquid', 'engine', 'kill']);
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'opensquid-cli-test-'));
  process.env.OPENSQUID_HOME = tempHome;
  savedEnvBin = process.env.OPENSQUID_ENGINE_BIN;
  delete process.env.OPENSQUID_ENGINE_BIN;
  stdoutCapture = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutCapture += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  });
  // Mock process.kill so SIGTERM doesn't escape the test sandbox.
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  // Fake timers so the 2s grace wait inside cmdKill resolves instantly.
  vi.useFakeTimers();
});

afterEach(() => {
  delete process.env.OPENSQUID_HOME;
  if (savedEnvBin !== undefined) {
    process.env.OPENSQUID_ENGINE_BIN = savedEnvBin;
  }
  stdoutSpy.mockRestore();
  killSpy.mockRestore();
  vi.useRealTimers();
  rmSync(tempHome, { recursive: true, force: true });
});

describe('opensquid engine kill', () => {
  it('prints "no engine daemon running" when nothing exists', async () => {
    await runKill();
    expect(stdoutCapture).toContain('no engine daemon running.');
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('reads pidfile, sends SIGTERM, cleans up socket + pidfile', async () => {
    const pidPath = join(tempHome, 'loop-engine.pid');
    const sockPath = join(tempHome, 'loop-engine.sock');
    await fs.writeFile(pidPath, '12345\n', 'utf8');
    await fs.writeFile(sockPath, '', 'utf8'); // stand-in for an actual socket

    // Kick off cmdKill. cmdKill awaits readFile (microtasks) then
    // process.kill (sync, mocked) then `new Promise(setTimeout(..., 2000))`.
    // We need to keep pumping until `done` resolves — a fixed-count loop
    // can race ahead of the timer scheduling on slow CI (Node 20 timing
    // variance). Pump-while-pending guarantees liveness regardless of
    // when cmdKill actually schedules the grace-period timer.
    const done = runKill();
    let resolved = false;
    void done.then(() => {
      resolved = true;
    });
    while (!resolved) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
    }
    await done;

    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(stdoutCapture).toContain('sent SIGTERM to pid=12345');
    expect(stdoutCapture).toContain('engine daemon stopped.');
    await expect(fs.stat(pidPath)).rejects.toThrow();
    await expect(fs.stat(sockPath)).rejects.toThrow();
  }, 15_000);

  it('handles ESRCH (stale pid) gracefully and still cleans up', async () => {
    killSpy.mockImplementation(() => {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    const pidPath = join(tempHome, 'loop-engine.pid');
    const sockPath = join(tempHome, 'loop-engine.sock');
    await fs.writeFile(pidPath, '99999\n', 'utf8');
    await fs.writeFile(sockPath, '', 'utf8');

    // No timer pump needed here — process.kill throws synchronously
    // so cmdKill skips the grace-period setTimeout entirely.
    await runKill();

    expect(stdoutCapture).toContain('failed');
    expect(stdoutCapture).toContain('continuing to cleanup');
    expect(stdoutCapture).toContain('engine daemon stopped.');
    await expect(fs.stat(pidPath)).rejects.toThrow();
    await expect(fs.stat(sockPath)).rejects.toThrow();
  });

  it('warns + cleans up on a malformed pidfile (non-numeric)', async () => {
    const pidPath = join(tempHome, 'loop-engine.pid');
    const sockPath = join(tempHome, 'loop-engine.sock');
    await fs.writeFile(pidPath, 'not-a-pid\n', 'utf8');
    await fs.writeFile(sockPath, '', 'utf8');

    // Malformed pidfile → cmdKill skips process.kill + setTimeout
    // entirely. No timer pump needed.
    await runKill();

    expect(killSpy).not.toHaveBeenCalled();
    expect(stdoutCapture).toContain('not a valid pid');
    expect(stdoutCapture).toContain('engine daemon stopped.');
    await expect(fs.stat(pidPath)).rejects.toThrow();
    await expect(fs.stat(sockPath)).rejects.toThrow();
  });

  it('cleans up a stale socket even when no pidfile is present', async () => {
    const sockPath = join(tempHome, 'loop-engine.sock');
    await fs.writeFile(sockPath, '', 'utf8');

    // No pidfile → cmdKill skips process.kill + setTimeout.
    await runKill();

    expect(killSpy).not.toHaveBeenCalled();
    expect(stdoutCapture).toContain('engine daemon stopped.');
    await expect(fs.stat(sockPath)).rejects.toThrow();
  });
});

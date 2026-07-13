import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcControl, runOneShotCli } from '../../src/runtime/spawn_lifecycle.js';
import {
  controlledExecutorProcess,
  requestExecutorControl,
} from '../../src/runtime/subagents/process_control.js';

const priorRoot = process.env.OPENSQUID_PROJECT_ROOT;

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`timed out waiting for ${path}: ${String(lastError)}`);
}

describe.skipIf(process.platform !== 'win32')('Windows Job Object process control', () => {
  let project: string;
  let cleanupControl: (() => void) | undefined;
  let executorRegistered = false;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'opensquid-winjob-'));
    await mkdir(join(project, '.opensquid'));
    process.env.OPENSQUID_PROJECT_ROOT = project;
    cleanupControl = undefined;
    executorRegistered = false;
  });

  afterEach(async () => {
    // A failed assertion must not strand the broker/Job Object and make the temp tree permanently EBUSY.
    if (executorRegistered) {
      await requestExecutorControl({
        executorId: 'windows-job-e2e',
        action: 'force_kill',
        requestedBy: 'tui',
        authorizedBy: 'tui:windows-e2e-cleanup',
      }).catch(() => undefined);
    }
    cleanupControl?.();
    if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
    await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('survives automatic EOF, terminates only the root, then force-kills the owned descendant job', async () => {
    const grandPidFile = join(project, 'grand.pid');
    const grand = join(project, 'grand.cjs');
    await writeFile(
      grand,
      `require('node:fs').writeFileSync(${JSON.stringify(grandPidFile)},String(process.pid));setInterval(()=>{},1000);`,
    );
    const child = join(project, 'child.cjs');
    await writeFile(
      child,
      `process.stdin.resume();require('node:child_process').spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
    );

    const control = controlledExecutorProcess({
      executorId: 'windows-job-e2e',
      wgId: 'wg-windows-job',
      role: 'fullstack-executor',
      base: realProcControl,
      pollMs: 20,
    });
    cleanupControl = () => control.dispose();
    executorRegistered = true;
    await runOneShotCli({
      cli: process.execPath,
      args: [child],
      cwd: project,
      prompt: '',
      timeoutMs: 500,
      timeoutError: () => new Error('expected timeout'),
      onShutdownRequested: () => control.markAutomaticShutdown(),
      procControl: control.procControl,
    }).catch(() => undefined);

    // PowerShell's first Add-Type compilation is cold on a fresh Windows runner. Wait for the target's
    // observable readiness instead of assuming the broker, C# compile, child, and grandchild all finish in
    // 500 ms. The transport has already reached its automatic EOF/timeout path; no OS signal was sent.
    const grandPid = Number(await waitForFile(grandPidFile, 10_000));
    expect(Number.isSafeInteger(grandPid) && grandPid > 0).toBe(true);
    expect(() => process.kill(grandPid, 0)).not.toThrow();

    const receipt = await requestExecutorControl({
      executorId: 'windows-job-e2e',
      action: 'terminate',
      requestedBy: 'tui',
      authorizedBy: 'tui:windows-e2e',
    });
    expect(receipt.result).toBe('applied');
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        process.kill(grandPid, 0);
      } catch {
        alive = false;
      }
    }
    // Windows has no portable POSIX TERM analogue: the human terminate action closes the exact owned Job
    // Object with a distinct exit code, and must still remove every descendant.
    expect(alive).toBe(false);
  }, 30_000);
});

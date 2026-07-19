import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcControl, runOneShotCli } from '../../src/runtime/spawn_lifecycle.js';
import {
  controlledOwnedProcess,
  requestProcessControl,
} from '../../src/runtime/processes/process_control.js';

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
  let processRegistered = false;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'opensquid-winjob-'));
    await mkdir(join(project, '.opensquid'));
    process.env.OPENSQUID_PROJECT_ROOT = project;
    cleanupControl = undefined;
    processRegistered = false;
  });

  afterEach(async () => {
    // A failed assertion must not strand the broker/Job Object and make the temp tree permanently EBUSY.
    if (processRegistered) {
      await requestProcessControl({
        processId: 'windows-job-e2e',
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

  it('survives stdin EOF until human terminate kills the exact owned descendant job', async () => {
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

    const control = controlledOwnedProcess({
      processId: 'windows-job-e2e',
      wgId: 'wg-windows-job',
      role: 'stage-process',
      ownership: 'owned',
      base: realProcControl,
      pollMs: 20,
    });
    cleanupControl = () => control.dispose();
    processRegistered = true;
    // Keep the invocation in flight while the cold PowerShell Add-Type broker starts. Awaiting an intentional
    // short inactivity timeout here used to kill the Job before the grandchild could publish readiness.
    const invocation = runOneShotCli({
      cli: process.execPath,
      args: [child],
      cwd: project,
      prompt: '',
      timeoutMs: 30_000,
      timeoutError: () => new Error('unexpected inactivity timeout before human control'),
      onShutdownRequested: () => control.markAutomaticShutdown(),
      procControl: control.procControl,
    }).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    const grandPid = Number(await waitForFile(grandPidFile, 20_000));
    expect(Number.isSafeInteger(grandPid) && grandPid > 0).toBe(true);
    expect(() => process.kill(grandPid, 0)).not.toThrow();

    const receipt = await requestProcessControl({
      processId: 'windows-job-e2e',
      action: 'terminate',
      requestedBy: 'tui',
      authorizedBy: 'tui:windows-e2e',
    });
    expect(receipt.result).toBe('applied');
    const outcome = await invocation;
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).not.toContain(
        'unexpected inactivity timeout before human control',
      );
    }
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
  }, 45_000);

  it('automatic inactivity timeout reclaims the exact owned descendant job', async () => {
    const grandPidFile = join(project, 'automatic-grand.pid');
    const grand = join(project, 'automatic-grand.cjs');
    await writeFile(
      grand,
      `require('node:fs').writeFileSync(${JSON.stringify(grandPidFile)},String(process.pid));setInterval(()=>{},1000);`,
    );
    const child = join(project, 'automatic-child.cjs');
    await writeFile(
      child,
      `require('node:child_process').spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:'ignore'});setInterval(()=>{},1000);`,
    );

    const control = controlledOwnedProcess({
      processId: 'windows-job-e2e',
      wgId: 'wg-windows-job',
      role: 'stage-process',
      ownership: 'owned',
      base: realProcControl,
      pollMs: 20,
    });
    cleanupControl = () => control.dispose();
    processRegistered = true;
    const invocation = runOneShotCli({
      cli: process.execPath,
      args: [child],
      cwd: project,
      prompt: '',
      timeoutMs: 20_000,
      timeoutError: () => new Error('expected automatic inactivity timeout'),
      onShutdownRequested: () => control.markAutomaticShutdown(),
      procControl: control.procControl,
    }).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );

    // Prove the grandchild entered the named Job before the automatic transport timeout owns cleanup.
    const grandPid = Number(await waitForFile(grandPidFile, 15_000));
    expect(Number.isSafeInteger(grandPid) && grandPid > 0).toBe(true);
    expect(() => process.kill(grandPid, 0)).not.toThrow();

    const outcome = await invocation;
    expect(outcome).toMatchObject({ kind: 'rejected' });
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toContain('expected automatic inactivity timeout');
    }
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
    expect(alive).toBe(false);
  }, 45_000);
});

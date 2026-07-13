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

describe.skipIf(process.platform !== 'win32')('Windows Job Object process control', () => {
  let project: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'opensquid-winjob-'));
    await mkdir(join(project, '.opensquid'));
    process.env.OPENSQUID_PROJECT_ROOT = project;
  });

  afterEach(async () => {
    if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
    await rm(project, { recursive: true, force: true });
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

    await new Promise((resolve) => setTimeout(resolve, 500));
    const grandPid = Number(await readFile(grandPidFile, 'utf8'));
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
    control.dispose();
    // Windows has no portable POSIX TERM analogue: the human terminate action closes the exact owned Job
    // Object with a distinct exit code, and must still remove every descendant.
    expect(alive).toBe(false);
  }, 30_000);
});

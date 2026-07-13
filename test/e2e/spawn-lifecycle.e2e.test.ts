/** Real OS proof for the human-only subprocess control boundary. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { realProcControl, runOneShotCli } from '../../src/runtime/spawn_lifecycle.js';
import {
  controlledExecutorProcess,
  requestExecutorControl,
} from '../../src/runtime/subagents/process_control.js';

const SKIP_E2E = process.env.E2E !== '1' || process.platform === 'win32';
const priorProjectRoot = process.env.OPENSQUID_PROJECT_ROOT;

describe.skipIf(SKIP_E2E)('spawn lifecycle e2e — human-only process-group signals', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-spawnlc-e2e-'));
    await mkdir(join(dir, '.opensquid'));
    process.env.OPENSQUID_PROJECT_ROOT = dir;
    delete process.env.OPENSQUID_SUPERVISED;
  });

  afterEach(async () => {
    if (priorProjectRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorProjectRoot;
    delete process.env.OPENSQUID_SUPERVISED;
    await rm(dir, { recursive: true, force: true });
  });

  it('automatic timeout leaves the tree alive; explicit human force-kill reaps it', async () => {
    const gpidFile = join(dir, 'gpid');
    const grand = join(dir, 'grand.cjs');
    await writeFile(
      grand,
      "process.on('SIGTERM',()=>{});" +
        "require('fs').writeFileSync(process.env.GPIDFILE,String(process.pid));" +
        'setInterval(()=>{},1000);',
      'utf8',
    );
    const childScript = join(dir, 'child.cjs');
    await writeFile(
      childScript,
      "process.stdin.resume();process.on('SIGTERM',()=>{});" +
        "const{spawn}=require('node:child_process');" +
        `spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:'ignore',env:{...process.env}});` +
        'setInterval(()=>{},1000);',
      'utf8',
    );

    const control = controlledExecutorProcess({
      executorId: 'e2e-process-tree',
      wgId: 'wg-e2e',
      role: 'executor',
      base: realProcControl,
      pollMs: 20,
    });
    await runOneShotCli({
      cli: process.execPath,
      args: [childScript],
      prompt: '',
      timeoutMs: 400,
      markSubagent: true,
      timeoutError: (ms) => new Error(`timeout ${String(ms)}`),
      onShutdownRequested: () => control.markAutomaticShutdown(),
      env: { GPIDFILE: gpidFile },
      procControl: control.procControl,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const gpid = Number(await readFile(gpidFile, 'utf8'));
    expect(() => process.kill(gpid, 0)).not.toThrow();

    await requestExecutorControl({
      executorId: 'e2e-process-tree',
      action: 'force_kill',
      requestedBy: 'cli',
      authorizedBy: 'cli:e2e',
    });
    const deadline = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        process.kill(gpid, 0);
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(gpid, 'SIGKILL');
    control.dispose();
    expect(alive).toBe(false);
  }, 20_000);
});

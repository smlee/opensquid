/** Real OS proof that one-shot timeout reconciliation leaves no owned process tree behind. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runOneShotCli } from '../../src/runtime/spawn_lifecycle.js';
import { runStreamingCli } from '../../src/runtime/streaming_cli.js';

const SKIP_E2E = process.env.E2E !== '1' || process.platform === 'win32';
const priorProjectRoot = process.env.OPENSQUID_PROJECT_ROOT;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return Number(await readFile(path, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`pid file not written: ${path}`);
}

describe.skipIf(SKIP_E2E)('spawn lifecycle e2e — automatic owned-tree reconciliation', () => {
  let dir: string;
  const emergencyPids: number[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-spawnlc-e2e-'));
    await mkdir(join(dir, '.opensquid'));
    process.env.OPENSQUID_PROJECT_ROOT = dir;
    delete process.env.OPENSQUID_SUPERVISED;
  });

  afterEach(async () => {
    for (const pid of emergencyPids.splice(0)) {
      if (!alive(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (priorProjectRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorProjectRoot;
    delete process.env.OPENSQUID_SUPERVISED;
    await rm(dir, { recursive: true, force: true });
  });

  it('one-shot SIGTERM grace then exact group SIGKILL reaps a timeout child and its SIGTERM-ignoring grandchild', async () => {
    const cpidFile = join(dir, 'cpid');
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
        "require('fs').writeFileSync(process.env.CPIDFILE,String(process.pid));" +
        "const{spawn}=require('node:child_process');" +
        `spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:'ignore',env:{...process.env}});` +
        'setInterval(()=>{},1000);',
      'utf8',
    );

    const invocation = runOneShotCli({
      cli: process.execPath,
      args: [childScript],
      prompt: '',
      timeoutMs: 400,
      graceMs: 200,
      markSubagent: true,
      timeoutError: (ms) => new Error(`timeout ${String(ms)}`),
      env: { CPIDFILE: cpidFile, GPIDFILE: gpidFile },
    });
    const [cpid, gpid] = await Promise.all([readPid(cpidFile), readPid(gpidFile)]);
    emergencyPids.push(cpid, gpid);
    await expect(invocation).rejects.toThrow('timeout 400');

    const deadline = Date.now() + 5_000;
    while ((alive(cpid) || alive(gpid)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive(cpid)).toBe(false);
    expect(alive(gpid)).toBe(false);
  }, 20_000);

  it('duplex timeout does not settle until its signal-ignoring child and grandchild tree is reclaimed', async () => {
    const cpidFile = join(dir, 'stream-cpid');
    const gpidFile = join(dir, 'stream-gpid');
    const grand = join(dir, 'stream-grand.cjs');
    await writeFile(
      grand,
      "process.on('SIGTERM',()=>{});" +
        "require('fs').writeFileSync(process.env.GPIDFILE,String(process.pid));" +
        'setInterval(()=>{},1000);',
      'utf8',
    );
    const childScript = join(dir, 'stream-child.cjs');
    await writeFile(
      childScript,
      "process.stdin.resume();process.on('SIGTERM',()=>{});" +
        "require('fs').writeFileSync(process.env.CPIDFILE,String(process.pid));" +
        "const{spawn}=require('node:child_process');" +
        `spawn(process.execPath,[${JSON.stringify(grand)}],{stdio:'ignore',env:{...process.env}});` +
        'setInterval(()=>{},1000);',
      'utf8',
    );

    const invocation = runStreamingCli({
      cli: process.execPath,
      args: [childScript],
      cwd: dir,
      timeoutMs: 400,
      graceMs: 200,
      processGroup: 'own',
      env: { CPIDFILE: cpidFile, GPIDFILE: gpidFile },
      onRecord: () => 'continue',
    });
    const [cpid, gpid] = await Promise.all([readPid(cpidFile), readPid(gpidFile)]);
    emergencyPids.push(cpid, gpid);
    let settled = false;
    void invocation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(settled).toBe(false);
    await expect(invocation).rejects.toThrow('streaming cli timeout');

    expect(alive(cpid)).toBe(false);
    expect(alive(gpid)).toBe(false);
  }, 20_000);
});

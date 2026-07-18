/**
 * ATL.4 — loop autospawn unit tests (T-auto-trigger-loop-on-scope-exit).
 *
 * FSM tests inject `statusFn` / `startFn` seams so idempotent / single-flight / fail-open behavior is isolated.
 * One process test spawns a bounded probe (never a real OpenSquid loop) to assert the operating-system child cwd.
 * Every filesystem and process artifact lives under an `mkdtemp`; cleanup terminates the probe and removes it.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loopPidPath } from '../paths.js';

import {
  ensureLoopRunning,
  loopStatus,
  resolveLoopEntrypoint,
  resolveLoopProject,
  startLoop,
  waitForLoopReadiness,
  type LoopStatus,
} from './loop_autospawn.js';
import { acquireLoopOwner } from './loop_owner.js';

const running = (pid: number): Promise<LoopStatus> =>
  Promise.resolve({ running: true, pid, uptime_ms: 1 });
const notRunning = (): Promise<LoopStatus> => Promise.resolve({ running: false });

describe('loop autospawn — ensureLoopRunning FSM (explicit target repo, injected spawn)', () => {
  let root: string;
  let priorRoot: string | undefined;

  beforeEach(async () => {
    priorRoot = process.env.OPENSQUID_PROJECT_ROOT;
    delete process.env.OPENSQUID_PROJECT_ROOT;
    root = await mkdtemp(join(tmpdir(), 'atl-autospawn-'));
    await mkdir(join(root, '.opensquid'));
  });
  afterEach(async () => {
    if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
    else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('already-running → { already_running } and NO spawn (idempotent)', async () => {
    const startFn = vi.fn();
    const res = await ensureLoopRunning(root, {
      statusFn: () => running(42),
      startFn: startFn as never,
    });
    expect(res).toEqual({ status: 'already_running', pid: 42 });
    expect(startFn).not.toHaveBeenCalled();
  });

  it('canonicalizes a configured project-root alias to the same target/store pair', async () => {
    process.env.OPENSQUID_PROJECT_ROOT = root;
    const startFn = vi.fn();
    const res = await ensureLoopRunning(root, {
      statusFn: () => running(42),
      startFn: startFn as never,
    });
    expect(res).toEqual({ status: 'already_running', pid: 42 });
    expect(startFn).not.toHaveBeenCalled();
  });

  it('not-running → passes the explicit target repo and store to one spawn', async () => {
    const startFn = vi.fn().mockResolvedValue({ pid: 99 });
    const res = await ensureLoopRunning(root, {
      statusFn: notRunning,
      startFn: startFn as never,
    });
    expect(res).toEqual({ status: 'spawned', pid: 99 });
    expect(startFn).toHaveBeenCalledTimes(1);
    const canonicalRoot = await realpath(root);
    expect(startFn).toHaveBeenCalledWith(
      { targetRepoRoot: canonicalRoot, storeRoot: join(canonicalRoot, '.opensquid') },
      {},
    );
  });

  it('a spawn fault → { status: "error" }, never throws (fail-open)', async () => {
    const res = await ensureLoopRunning(root, {
      statusFn: notRunning,
      startFn: () => Promise.reject(new Error('boom')),
    });
    expect(res.status).toBe('error');
    expect(res.error).toContain('boom');
  });

  it('two concurrent callers spawn at most one candidate in-process', async () => {
    let started = 0;
    let up = false;
    const statusFn = (): Promise<LoopStatus> => (up ? running(777) : notRunning());
    const startFn = vi.fn((): Promise<{ pid: number }> => {
      started += 1;
      up = true;
      return Promise.resolve({ pid: 777 });
    });
    const [a, b] = await Promise.all([
      ensureLoopRunning(root, { statusFn, startFn }),
      ensureLoopRunning(root, { statusFn, startFn }),
    ]);
    expect(started).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toContain('spawned');
    expect(
      statuses.some((status) => status === 'waited_for_peer' || status === 'already_running'),
    ).toBe(true);
  });

  it('rejects a workspace or nested cwd that does not exactly own the selected store', async () => {
    const nested = join(root, 'nested');
    await mkdir(nested);
    const res = await ensureLoopRunning(nested);
    expect(res.status).toBe('error');
    expect(res.error).toContain('target repository does not own the resolved store');
  });

  it('resolveLocalStoreDir throwing (no project store) → { status: "error" }, never throws', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'atl-noproj-'));
    try {
      const res = await ensureLoopRunning(bare);
      expect(res.status).toBe('error');
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe('loop autospawn — real child cwd', () => {
  it('starts the subprocess in the explicitly selected target repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atl-real-spawn-'));
    const storeRoot = join(root, '.opensquid');
    const observed = join(root, 'observed-cwd.txt');
    const probe = join(root, 'probe.mjs');
    await mkdir(storeRoot);
    await writeFile(
      probe,
      [
        `import { writeFileSync } from 'node:fs';`,
        `writeFileSync(${JSON.stringify(observed)}, process.cwd());`,
        `setInterval(() => {}, 1000);`,
      ].join('\n'),
    );

    let pid: number | undefined;
    try {
      const project = await resolveLoopProject(root);
      const result = await startLoop(project, {
        entrypoint: probe,
        readyFn: async (_project, spawnedPid) => {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
              await readFile(observed, 'utf8');
              return spawnedPid;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          throw new Error('cwd probe did not report');
        },
      });
      pid = result.pid;
      expect(await readFile(observed, 'utf8')).toBe(await realpath(root));
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* child already exited */
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('loop autospawn — loopStatus (kernel owner authority)', () => {
  let root: string;
  let store: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'atl-status-'));
    store = join(root, '.opensquid');
    await mkdir(store);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('pidfile without an endpoint owner is ignored and reports not running', async () => {
    const stale = '{"version":1,"pid":999}\n';
    await writeFile(loopPidPath(store), stale);
    expect(await loopStatus(store)).toEqual({ running: false });
    expect(await readFile(loopPidPath(store), 'utf8')).toBe(stale);
  });

  it('a validated lifetime endpoint reports running and repairs the pid projection', async () => {
    const acquired = await acquireLoopOwner({ targetRepoRoot: root, storeRoot: store });
    if (acquired.status !== 'acquired') throw new Error('expected owner');
    try {
      const status = await loopStatus(store);
      expect(status).toMatchObject({ running: true, pid: process.pid });
      expect(JSON.parse(await readFile(loopPidPath(store), 'utf8'))).toMatchObject({
        pid: process.pid,
        endpoint: acquired.lease.endpoint,
      });
    } finally {
      await acquired.lease.close();
    }
  });
});

describe('loop autospawn — pushed readiness', () => {
  it('accepts one bounded LF-delimited startup record', async () => {
    const stream = new PassThrough();
    const result = waitForLoopReadiness(stream);
    stream.end(
      `${JSON.stringify({ kind: 'opensquid_loop_ready', version: 1, status: 'acquired', pid: 42 })}\n`,
    );
    await expect(result).resolves.toEqual({ status: 'acquired', pid: 42 });
  });

  it('fails closed on EOF, malformed records, and trailing records', async () => {
    const ended = new PassThrough();
    const endedResult = waitForLoopReadiness(ended);
    ended.end();
    await expect(endedResult).rejects.toThrow('ended early');

    const malformed = new PassThrough();
    const malformedResult = waitForLoopReadiness(malformed);
    malformed.end('{"kind":"wrong"}\n');
    await expect(malformedResult).rejects.toThrow('malformed readiness');

    const trailing = new PassThrough();
    const trailingResult = waitForLoopReadiness(trailing);
    trailing.end(
      `${JSON.stringify({ kind: 'opensquid_loop_ready', version: 1, status: 'acquired', pid: 42 })}\nextra`,
    );
    await expect(trailingResult).rejects.toThrow('trailing bytes');
  });
});

describe('loop autospawn — path helpers + entrypoint (data-shape)', () => {
  it('loopPidPath resolves the derived projection under the project store', () => {
    expect(loopPidPath('/x/.opensquid')).toBe('/x/.opensquid/loop.pid');
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

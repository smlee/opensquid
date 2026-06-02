/**
 * agent_bridge — CLI tests (WAB.7).
 *
 * Coverage:
 *   - status: no pid file → "not running"; live pid → "running (pid=N)";
 *     stale pid → "not running (stale pid=N)"
 *   - start: spawns detached run-foreground (mocked spawn); writes pid to log
 *   - start while running → exit 2 + "already running"
 *   - start with stale pid → cleans pid file then spawns
 *   - stop: alive → SIGTERM sent; dead → "not running"
 *   - restart: SIGTERM + wait + spawn
 *   - run-foreground without project UUID → exit 1
 *
 * The CLI module uses a `registerAgentBridge(program, deps)` registration
 * with extensive test injection (daemonCtor, env, cwd, spawnFn, killFn,
 * out/err/exit). We exercise every subcommand via `program.parseAsync`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerAgentBridge, type AgentBridgeCliDeps } from './cli.js';
import type { AgentBridgeDaemon } from './daemon.js';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

let tmpRoot: string;
let env: NodeJS.ProcessEnv;
let stdoutChunks: string[];
let stderrChunks: string[];
let exitCode: number | null;
let spawnCalls: { cmd: string; args: string[] }[];
let nextSpawnPid: number | undefined;
let killCalls: { pid: number; sig: NodeJS.Signals | 0 }[];
let killThrows: Record<number, NodeJS.ErrnoException>;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'wab7-cli-'));
  env = { OPENSQUID_HOME: tmpRoot };
  stdoutChunks = [];
  stderrChunks = [];
  exitCode = null;
  spawnCalls = [];
  nextSpawnPid = 12345;
  killCalls = [];
  killThrows = {};
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeProgram(extraDeps: Partial<AgentBridgeCliDeps> = {}): Command {
  const program = new Command();
  const deps: AgentBridgeCliDeps = {
    env,
    out: (chunk) => stdoutChunks.push(chunk),
    err: (chunk) => stderrChunks.push(chunk),
    exit: (code) => {
      exitCode = code;
    },
    spawnFn: (cmd, args, _opts) => {
      spawnCalls.push({ cmd, args });
      return {
        ...(nextSpawnPid !== undefined ? { pid: nextSpawnPid } : {}),
        unref: () => undefined,
      };
    },
    killFn: (pid, sig) => {
      killCalls.push({ pid, sig });
      const t = killThrows[pid];
      if (t !== undefined) throw t;
    },
    waitForever: () => Promise.resolve(),
    ...extraDeps,
  };
  registerAgentBridge(program, deps);
  return program;
}

function stdout(): string {
  return stdoutChunks.join('');
}
function stderr(): string {
  return stderrChunks.join('');
}

async function run(program: Command, argv: string[]): Promise<void> {
  // commander wants ['node', 'opensquid', ...]
  await program.parseAsync(['node', 'opensquid', ...argv]);
  // Give pending microtasks a chance to flush (subcommand action handlers
  // wrap their body in `void (async () => {})()` so the parseAsync return
  // doesn't await them).
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function writePidFile(pid: number): Promise<void> {
  await writeFile(join(tmpRoot, 'agent-bridge.pid'), String(pid), 'utf8');
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('agent-bridge status', () => {
  it('reports not running when no pid file present', async () => {
    const program = makeProgram();
    await run(program, ['agent-bridge', 'status']);
    expect(stdout()).toMatch(/not running.*no pid file/);
  });

  it('reports running when pid file exists and pid is alive', async () => {
    await writePidFile(42);
    const program = makeProgram(); // killFn is no-op (success) by default
    await run(program, ['agent-bridge', 'status']);
    expect(stdout()).toMatch(/running \(pid=42\)/);
    expect(killCalls).toContainEqual({ pid: 42, sig: 0 });
  });

  it('reports stale pid when killFn throws ESRCH', async () => {
    await writePidFile(99);
    const esrch = Object.assign(new Error('No such process'), { code: 'ESRCH' });
    killThrows[99] = esrch;
    const program = makeProgram();
    await run(program, ['agent-bridge', 'status']);
    expect(stdout()).toMatch(/not running \(stale pid=99/);
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('agent-bridge start', () => {
  it('spawns the daemon detached and prints pid', async () => {
    const program = makeProgram();
    await run(program, ['agent-bridge', 'start']);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toContain('run-foreground');
    expect(stdout()).toMatch(/spawned \(pid=12345\)/);
    expect(exitCode).toBeNull();
  });

  it('refuses to start when daemon is already running (exit 2)', async () => {
    await writePidFile(7);
    const program = makeProgram(); // killFn success = pid 7 is alive
    await run(program, ['agent-bridge', 'start']);
    expect(spawnCalls).toHaveLength(0);
    expect(stderr()).toMatch(/already running \(pid=7\)/);
    expect(exitCode).toBe(2);
  });

  it('cleans up stale pid file and spawns', async () => {
    await writePidFile(98);
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    killThrows[98] = esrch;
    const program = makeProgram();
    await run(program, ['agent-bridge', 'start']);
    expect(spawnCalls).toHaveLength(1);
    expect(stdout()).toMatch(/spawned/);
  });

  it('reports failure when spawn returns no pid', async () => {
    nextSpawnPid = undefined;
    const program = makeProgram();
    await run(program, ['agent-bridge', 'start']);
    expect(stderr()).toMatch(/spawn returned no pid/);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('agent-bridge stop', () => {
  it('reports not running when no pid file present', async () => {
    const program = makeProgram();
    await run(program, ['agent-bridge', 'stop']);
    expect(stdout()).toMatch(/not running/);
    expect(killCalls).toHaveLength(0);
  });

  it('sends SIGTERM when pid is alive', async () => {
    await writePidFile(55);
    const program = makeProgram();
    await run(program, ['agent-bridge', 'stop']);
    // killCalls contains both the liveness probe (sig 0) and the SIGTERM.
    expect(killCalls).toContainEqual({ pid: 55, sig: 0 });
    expect(killCalls).toContainEqual({ pid: 55, sig: 'SIGTERM' });
    expect(stdout()).toMatch(/SIGTERM -> pid 55/);
  });

  it('cleans up stale pid file silently', async () => {
    await writePidFile(101);
    const esrch = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    killThrows[101] = esrch;
    const program = makeProgram();
    await run(program, ['agent-bridge', 'stop']);
    expect(stdout()).toMatch(/not running/);
  });
});

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

describe('agent-bridge restart', () => {
  it('SIGTERMs running daemon then spawns', async () => {
    await writePidFile(77);
    const program = makeProgram();
    // Race the restart wait by rm'ing the pidfile while restart is in flight.
    // run() drains microtasks; we use a sibling delete BEFORE run() so the
    // waitForPidfileGone loop sees no file immediately.
    await rm(join(tmpRoot, 'agent-bridge.pid'), { force: true });
    await writePidFile(77);
    setTimeout(() => {
      void rm(join(tmpRoot, 'agent-bridge.pid'), { force: true });
    }, 10);
    await run(program, ['agent-bridge', 'restart']);
    expect(killCalls).toContainEqual({ pid: 77, sig: 'SIGTERM' });
    expect(spawnCalls).toHaveLength(1);
    expect(stdout()).toMatch(/restarted \(pid=12345\)/);
  }, 6000);

  it('spawns even when not running (no SIGTERM needed)', async () => {
    const program = makeProgram();
    await run(program, ['agent-bridge', 'restart']);
    expect(killCalls.filter((k) => k.sig === 'SIGTERM')).toHaveLength(0);
    expect(spawnCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// run-foreground
// ---------------------------------------------------------------------------

describe('agent-bridge run-foreground', () => {
  it('fails with helpful hint when project UUID is missing', async () => {
    const program = makeProgram({ cwd: () => tmpRoot });
    // tmpRoot has no `.opensquid/project.json` and env has no project UUID.
    await run(program, ['agent-bridge', 'run-foreground']);
    expect(stderr()).toMatch(/project UUID not found/);
    expect(stderr()).toMatch(/opensquid setup chat/);
    expect(exitCode).toBe(1);
  });

  it('walks cwd up to find .opensquid/project.json', async () => {
    const projectDir = join(tmpRoot, 'project');
    await mkdir(join(projectDir, '.opensquid'), { recursive: true });
    await writeFile(
      join(projectDir, '.opensquid', 'project.json'),
      JSON.stringify({ version: 1, id: 'p', uuid: 'walked-uuid-123' }),
      'utf8',
    );
    // Inject a daemon stub that captures the projectUuid.
    let receivedUuid: string | null = null;
    class StubDaemon {
      constructor(opts: { projectUuid: string }) {
        receivedUuid = opts.projectUuid;
      }
      start = (): Promise<void> => Promise.resolve();
      shutdown = (): Promise<void> => Promise.resolve();
    }
    const program = makeProgram({
      cwd: () => projectDir,
      daemonCtor: StubDaemon as unknown as typeof AgentBridgeDaemon,
    });
    await run(program, ['agent-bridge', 'run-foreground']);
    expect(receivedUuid).toBe('walked-uuid-123');
    expect(stdout()).toMatch(/agent-bridge: running/);
  });

  it('honors OPENSQUID_PROJECT_UUID env without walking', async () => {
    env.OPENSQUID_PROJECT_UUID = 'env-uuid-456';
    let receivedUuid: string | null = null;
    class StubDaemon {
      constructor(opts: { projectUuid: string }) {
        receivedUuid = opts.projectUuid;
      }
      start = (): Promise<void> => Promise.resolve();
      shutdown = (): Promise<void> => Promise.resolve();
    }
    const program = makeProgram({
      cwd: () => tmpRoot,
      daemonCtor: StubDaemon as unknown as typeof AgentBridgeDaemon,
    });
    await run(program, ['agent-bridge', 'run-foreground']);
    expect(receivedUuid).toBe('env-uuid-456');
  });

  it('surfaces daemon.start() failures via exit 1', async () => {
    env.OPENSQUID_PROJECT_UUID = 'env-uuid-456';
    class StubDaemon {
      start = (): Promise<void> => Promise.reject(new Error('boom'));
      shutdown = (): Promise<void> => Promise.resolve();
    }
    const program = makeProgram({
      daemonCtor: StubDaemon as unknown as typeof AgentBridgeDaemon,
    });
    await run(program, ['agent-bridge', 'run-foreground']);
    expect(stderr()).toMatch(/start failed.*boom/);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// run-foreground --general (CAT.6 — project-less general session)
// ---------------------------------------------------------------------------

describe('agent-bridge run-foreground --general (CAT.6)', () => {
  it('runs PROJECT-LESS: no project uuid required, umbrella=general, projectLess:true', async () => {
    let received: {
      projectUuid: string;
      umbrellaId?: string;
      projectLess?: boolean;
      packRoot: string;
    } | null = null;
    class StubDaemon {
      constructor(opts: {
        projectUuid: string;
        umbrellaId?: string;
        projectLess?: boolean;
        packRoot: string;
      }) {
        received = opts;
      }
      start = (): Promise<void> => Promise.resolve();
      shutdown = (): Promise<void> => Promise.resolve();
    }
    // cwd has NO project.json + env has NO project uuid — the general path must
    // not even try to resolve a project (it would otherwise exit 1).
    const program = makeProgram({
      cwd: () => tmpRoot,
      daemonCtor: StubDaemon as unknown as typeof AgentBridgeDaemon,
    });
    await run(program, ['agent-bridge', 'run-foreground', '--general']);
    // `received` is assigned only inside StubDaemon's constructor, which TS's
    // control-flow analysis can't observe — it pins `received` to `null`. Cast
    // back to the captured shape so the assertions type-check.
    const got = received as {
      projectUuid: string;
      umbrellaId?: string;
      projectLess?: boolean;
      packRoot: string;
    } | null;
    expect(got).not.toBeNull();
    expect(got?.projectUuid).toBe('');
    expect(got?.umbrellaId).toBe('general');
    expect(got?.projectLess).toBe(true);
    expect(got?.packRoot).toMatch(/[/\\]general$/);
    expect(stdout()).toMatch(/agent-bridge: running \(general/);
  });

  it('honors OPENSQUID_GENERAL_PACK_ROOT for the general packRoot', async () => {
    env.OPENSQUID_GENERAL_PACK_ROOT = '/custom/general-pack';
    let receivedPackRoot: string | null = null;
    class StubDaemon {
      constructor(opts: { packRoot: string }) {
        receivedPackRoot = opts.packRoot;
      }
      start = (): Promise<void> => Promise.resolve();
      shutdown = (): Promise<void> => Promise.resolve();
    }
    const program = makeProgram({
      cwd: () => tmpRoot,
      daemonCtor: StubDaemon as unknown as typeof AgentBridgeDaemon,
    });
    await run(program, ['agent-bridge', 'run-foreground', '--general']);
    expect(receivedPackRoot).toBe('/custom/general-pack');
  });

  it('`start --general` spawns run-foreground WITH the --general flag', async () => {
    const program = makeProgram();
    await run(program, ['agent-bridge', 'start', '--general']);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toContain('run-foreground');
    expect(spawnCalls[0]?.args).toContain('--general');
  });

  it('`start` WITHOUT --general does not forward the flag (project-scoped, unchanged)', async () => {
    const program = makeProgram();
    await run(program, ['agent-bridge', 'start']);
    expect(spawnCalls[0]?.args).toContain('run-foreground');
    expect(spawnCalls[0]?.args).not.toContain('--general');
  });
});

/**
 * agent_bridge — `opensquid agent-bridge {start|stop|status|restart|run-foreground}` CLI (WAB.7).
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.7 §"CLI".
 *
 * Shape: start spawns detached `run-foreground`; stop/status read pid file +
 * `kill -0` liveness; restart = stop + wait for pid removal + start;
 * run-foreground is the actual daemon entry (constructs AgentBridgeDaemon,
 * starts it, then awaits a never-resolving promise — signal handlers in
 * daemon.ts call shutdown() + process.exit(0)).
 *
 * Resolution chains:
 *   projectUuid: OPENSQUID_PROJECT_UUID → cwd walk for `.opensquid/project.json` → hard-fail
 *   packRoot:    OPENSQUID_PACK_ROOT → `~/.opensquid/packs/default/` (loadPack throws on missing manifest)
 *
 * Exit codes: 0 = success (including not-running for stop/status), 1 =
 * generic failure, 2 = `start` invoked while another daemon is running.
 *
 * Imports from: node:child_process, node:fs/promises, node:path, commander,
 *   ./daemon.js.
 * Imported by: src/cli.ts (registers `agent-bridge` parent verb).
 */

import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Command } from 'commander';

import { OPENSQUID_HOME } from '../paths.js';

import {
  AgentBridgeDaemon,
  agentBridgePidPath,
  resolvePackRootFromEnv,
  resolveProjectUuidFromEnv,
} from './daemon.js';

interface ProjectCard {
  version: 1;
  id: string;
  uuid: string;
}

export interface AgentBridgeCliDeps {
  /** Test injection — override the daemon class. Defaults to AgentBridgeDaemon. */
  daemonCtor?: typeof AgentBridgeDaemon;
  /** Test injection — override env access. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test injection — override cwd. Defaults to `process.cwd()`. */
  cwd?: () => string;
  /** Test injection — capture stdout/stderr writes. Defaults to process streams. */
  out?: (chunk: string) => void;
  err?: (chunk: string) => void;
  /** Test injection — exit code sink. Defaults to setting process.exitCode. */
  exit?: (code: number) => void;
  /** Test injection — override spawn (start verb). Defaults to child_process.spawn. */
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { detached: boolean },
  ) => { pid?: number; unref: () => void };
  /** Test injection — override `process.kill` (stop/status). Defaults to process.kill. */
  killFn?: (pid: number, sig: NodeJS.Signals | 0) => void;
  /** Test injection — `read-foreground` runs forever in production; tests
   *  pass a finite waiter so the spawn smoke test terminates. */
  waitForever?: () => Promise<void>;
}

const DEFAULTS = {
  out: (chunk: string): void => {
    process.stdout.write(chunk);
  },
  err: (chunk: string): void => {
    process.stderr.write(chunk);
  },
  exit: (code: number): void => {
    process.exitCode = code;
  },
  spawnFn: (
    cmd: string,
    args: string[],
    opts: { detached: boolean },
  ): { pid?: number; unref: () => void } => {
    const child = spawn(cmd, args, { detached: opts.detached, stdio: 'ignore' });
    return { ...(child.pid !== undefined ? { pid: child.pid } : {}), unref: () => child.unref() };
  },
  killFn: (pid: number, sig: NodeJS.Signals | 0): void => {
    process.kill(pid, sig);
  },
  waitForever: (): Promise<void> => new Promise(() => undefined),
};

/** Register the `agent-bridge` parent verb + every subcommand. */
export function registerAgentBridge(parent: Command, deps: AgentBridgeCliDeps = {}): Command {
  const out = deps.out ?? DEFAULTS.out;
  const err = deps.err ?? DEFAULTS.err;
  const exit = deps.exit ?? DEFAULTS.exit;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? (() => process.cwd());
  const spawnFn = deps.spawnFn ?? DEFAULTS.spawnFn;
  const killFn = deps.killFn ?? DEFAULTS.killFn;
  const waitForever = deps.waitForever ?? DEFAULTS.waitForever;
  const Ctor = deps.daemonCtor ?? AgentBridgeDaemon;

  const group = parent
    .command('agent-bridge')
    .description('Warm-pool chat-agent daemon (start | stop | status | restart | run-foreground)');

  group
    .command('status')
    .description('Report agent-bridge daemon status (running pid or "not running").')
    .action(async () => {
      const result = await readLivePid(env, killFn);
      if (result.alive) {
        out(`agent-bridge: running (pid=${String(result.pid)})\n`);
      } else if (result.stalePid !== undefined) {
        out(
          `agent-bridge: not running (stale pid=${String(result.stalePid)} at ${pidPathFor(env)})\n`,
        );
      } else {
        out(`agent-bridge: not running (no pid file at ${pidPathFor(env)})\n`);
      }
    });

  const doSpawn = (label: 'spawned' | 'restarted'): void => {
    const argv1 = process.argv[1] ?? 'opensquid';
    const child = spawnFn(process.execPath, [resolve(argv1), 'agent-bridge', 'run-foreground'], {
      detached: true,
    });
    child.unref();
    if (child.pid === undefined) {
      err('agent-bridge: spawn returned no pid\n');
      exit(1);
      return;
    }
    out(`agent-bridge: ${label} (pid=${String(child.pid)})\n`);
  };

  group
    .command('start')
    .description('Spawn the agent-bridge daemon detached and return.')
    .action(async () => {
      const live = await readLivePid(env, killFn);
      if (live.alive) {
        err(`agent-bridge: already running (pid=${String(live.pid)})\n`);
        exit(2);
        return;
      }
      if (live.stalePid !== undefined) {
        await rm(pidPathFor(env), { force: true }).catch(() => undefined);
      }
      doSpawn('spawned');
    });

  group
    .command('stop')
    .description('Send SIGTERM to the running agent-bridge daemon.')
    .action(async () => {
      const live = await readLivePid(env, killFn);
      if (!live.alive) {
        if (live.stalePid !== undefined) {
          await rm(pidPathFor(env), { force: true }).catch(() => undefined);
        }
        out('agent-bridge: not running\n');
        return;
      }
      try {
        killFn(live.pid, 'SIGTERM');
        out(`agent-bridge: SIGTERM -> pid ${String(live.pid)}\n`);
      } catch (e) {
        err(`agent-bridge: kill failed: ${e instanceof Error ? e.message : String(e)}\n`);
        exit(1);
      }
    });

  group
    .command('restart')
    .description('Stop + brief wait for pid file removal + start.')
    .action(async () => {
      const live = await readLivePid(env, killFn);
      if (live.alive) {
        try {
          killFn(live.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        // 2s is generous — start's stale-pid cleanup handles the miss too.
        await waitForPidfileGone(env, 2000);
      }
      doSpawn('restarted');
    });

  group
    .command('run-foreground')
    .description('Run the daemon in the current process (foreground; used by `start` spawn).')
    .action(async () => {
      const projectUuid = resolveProjectUuidFromEnv(env) ?? (await walkForProjectUuid(cwd()));
      if (projectUuid === null) {
        err(
          'agent-bridge: project UUID not found. ' +
            'Set OPENSQUID_PROJECT_UUID or run `opensquid setup chat` to create `.opensquid/project.json`.\n',
        );
        exit(1);
        return;
      }
      const packRoot = resolvePackRootFromEnv(env);
      const daemon = new Ctor({ projectUuid, packRoot });
      try {
        await daemon.start();
      } catch (e) {
        err(`agent-bridge: start failed: ${e instanceof Error ? e.message : String(e)}\n`);
        exit(1);
        return;
      }
      out(`agent-bridge: running (project=${projectUuid}, pack=${packRoot})\n`);
      // Block until SIGTERM/SIGINT — the signal handlers in daemon.ts
      // call shutdown() + process.exit(0). The waitForever Promise gives
      // tests a seam to terminate the foreground process deterministically.
      await waitForever();
    });

  return group;
}

function pidPathFor(env: NodeJS.ProcessEnv): string {
  const home = env.OPENSQUID_HOME ?? OPENSQUID_HOME();
  return join(home, 'agent-bridge.pid');
}

type PidResult = { alive: true; pid: number } | { alive: false; stalePid?: number };

/** Read pid file + `kill -0` liveness check. */
async function readLivePid(
  env: NodeJS.ProcessEnv,
  killFn: (pid: number, sig: NodeJS.Signals | 0) => void,
): Promise<PidResult> {
  const p = pidPathFor(env);
  let raw: string;
  try {
    raw = await readFile(p, 'utf8');
  } catch {
    return { alive: false };
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return { alive: false };
  try {
    killFn(pid, 0);
    return { alive: true, pid };
  } catch (e) {
    // EPERM = process exists but owned by someone else (still counts alive).
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return { alive: true, pid };
    return { alive: false, stalePid: pid };
  }
}

/** Walk cwd up looking for `.opensquid/project.json`. 64-level cap mirrors
 *  the same chain in `src/mcp/chat-bridge-server.ts`. */
async function walkForProjectUuid(startDir: string): Promise<string | null> {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, '.opensquid', 'project.json');
    try {
      const raw = await readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as ProjectCard;
      if (parsed?.version === 1 && parsed.uuid && parsed.id) return parsed.uuid;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Wait up to `timeoutMs` for the agent-bridge pidfile to disappear. */
async function waitForPidfileGone(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const p = pidPathFor(env);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(p, 'utf8');
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Re-exported for the parent CLI registration in src/cli.ts. */
export { agentBridgePidPath };

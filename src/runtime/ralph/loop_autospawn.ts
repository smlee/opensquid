/**
 * Loop auto-spawn (T-auto-trigger-loop-on-scope-exit, ATL.1) — start-if-not-running for the gated-ralph loop.
 *
 * The loop analog of the chat-daemon autospawn (`src/channels/daemon/{autospawn,lifecycle}.ts`): a config-free
 * liveness gate → atomic single-flight spawn-lock → re-check → detached+`unref` spawn of `dist/cli.js loop` →
 * a loser waits for the winner's pidfile → NEVER throws. `ensureLoopRunning` is fired FAIL-OPEN from the shared
 * checkpoint writer on the human SCOPE→scope_write advance (ATL.3, `loop_stage.ts`) so an interactive scope-exit
 * seamlessly hands off to the auto-driving loop with no manual `opensquid loop` launch.
 *
 * ONE deliberate divergence from the chat-daemon precedent: the loop's pid + spawn-lock are PROJECT-LOCAL
 * (`<root>/.opensquid/`, resolved from `cwd` via `resolveLocalStoreDir`), NOT machine-global (`OPENSQUID_HOME`).
 * A loop drives ONE project's project-local board (commit `a023159` — "project-local state"), so liveness and the
 * single-flight lock must be per-project: two projects can each run their own loop without colliding. The
 * chat-daemon's `anyChatConfigured` gate has NO loop analog — a loop is drivable whenever the board has a ready
 * item, so dropping the config gate is the correct simplification (the liveness gate + the caller's `scope_write`
 * guard are the only gates).
 *
 * STAGE-BLIND by contract (ask Boundary: "core = the generic loop-trigger … no stage vocabulary"): this module
 * knows nothing about scope/plan/author/code/deploy — WHICH transition triggers is the policy caller's concern.
 *
 * Imports from: node:child_process, node:fs, node:path, node:url, ../paths.
 * Imported by: src/runtime/ralph/loop_stage.ts (the scope-3 fail-open trigger) + tests.
 */

import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLocalStoreDir, loopPidPath, loopLockPath } from '../paths.js';

const STALE_LOCK_AGE_MS = 15_000;
const PIDFILE_WAIT_MS = 8_000;
const POLL_INTERVAL_MS = 100;

export type LoopStatus =
  | { running: true; pid: number; uptime_ms: number | null }
  | { running: false; stale_pid?: number };

export interface LoopAutoSpawnResult {
  status: 'spawned' | 'already_running' | 'waited_for_peer' | 'error';
  pid?: number;
  error?: string;
}

/** `kill -0 <pid>` liveness — ESRCH (dead) → false, EPERM (foreign live) → true. Mirrors lifecycle.ts:39-46. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the PROJECT-LOCAL loop pidfile and report liveness. Mirrors lifecycle.ts:status() but per-project: the
 * pidfile lives under `<root>/.opensquid/`, so `root` is the store dir (as returned by `resolveLocalStoreDir`).
 * A pidfile pointing at a dead pid reports `{ running: false, stale_pid }` — read-only; the caller reclaims it.
 */
export async function loopStatus(root: string): Promise<LoopStatus> {
  const pidFile = loopPidPath(root);
  if (!existsSync(pidFile)) return { running: false };
  let raw: string;
  try {
    raw = await fs.readFile(pidFile, 'utf8');
  } catch {
    return { running: false };
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return { running: false };
  if (!isProcessAlive(pid)) return { running: false, stale_pid: pid };
  let uptime_ms: number | null = null;
  try {
    uptime_ms = Date.now() - (await fs.stat(pidFile)).mtimeMs;
  } catch {
    /* keep null */
  }
  return { running: true, pid, uptime_ms };
}

/** Resolve `dist/cli.js` from this module (dist/runtime/ralph/loop_autospawn.js → dist/cli.js). Test seam. */
export function resolveLoopEntrypoint(): string {
  const override = process.env.OPENSQUID_CLI_ENTRYPOINT;
  if (override !== undefined && override.length > 0) return override;
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), '..', '..', 'cli.js'); // dist/runtime/ralph → dist → dist/cli.js
}

/**
 * Spawn `<node> dist/cli.js loop` DETACHED + unref, waiting for the worker's PROJECT-LOCAL pidfile so the
 * single-flight lock is only released once liveness is observable. Mirrors lifecycle.ts:startDaemon (90-144),
 * dropping the machine-global log header + `OPENSQUID_HOME` env thread (the loop's paths are cwd-derived).
 * The worker (ATL.2, `ralph.ts` loop action) writes its OWN pid on boot as its first action, so this wait is
 * short; a worker that never writes it makes `waitForPidfile` throw → caught by `ensureLoopRunning` (fail-open).
 */
export async function startLoop(
  root: string,
  opts: { entrypoint?: string; nodeBin?: string } = {},
): Promise<{ pid: number }> {
  const cur = await loopStatus(root);
  if (cur.running) return { pid: cur.pid };
  const pidFile = loopPidPath(root);
  if (cur.stale_pid !== undefined)
    await fs.unlink(pidFile).catch(() => {
      /* race-tolerant — a stale pidfile the reclaim may have already removed */
    });
  const logFile = resolve(root, 'loop.log'); // `root` is already the resolved <root>/.opensquid store dir
  await fs.mkdir(dirname(logFile), { recursive: true });
  const childLogFd = openSync(logFile, 'a');
  const child = spawn(
    opts.nodeBin ?? process.execPath,
    [opts.entrypoint ?? resolveLoopEntrypoint(), 'loop'],
    {
      detached: true,
      stdio: ['ignore', childLogFd, childLogFd],
      env: process.env,
    },
  );
  child.unref();
  closeSync(childLogFd);
  if (child.pid === undefined) throw new Error('loop-autospawn: spawn returned no pid');
  const workerPid = await waitForPidfile(pidFile, PIDFILE_WAIT_MS); // worker writes its OWN pid on boot (ATL.2)
  return { pid: workerPid };
}

export interface EnsureLoopRunningDeps {
  /** Override the spawned worker's entrypoint (defaults to `dist/cli.js`). */
  entrypoint?: string;
  /** Override the liveness probe (defaults to `loopStatus`). */
  statusFn?: (root: string) => Promise<LoopStatus>;
  /** Override the spawn (defaults to `startLoop`). */
  startFn?: (root: string, opts: { entrypoint?: string }) => Promise<{ pid: number }>;
}

/**
 * Best-effort: ensure a loop is running for `cwd`'s project. Idempotent (already-running → no spawn),
 * single-flight (concurrent callers spawn at most one), NEVER throws (the whole body is wrapped — a fault on
 * ANY path, including `resolveLocalStoreDir` throwing outside a project store, returns `{status:'error'}`). This
 * is the safety floor for the scope-3 caller: a trigger fault must never break the scope-exit that fired it.
 */
export async function ensureLoopRunning(
  cwd: string,
  deps: EnsureLoopRunningDeps = {},
): Promise<LoopAutoSpawnResult> {
  const statusFn = deps.statusFn ?? loopStatus;
  const startFn = deps.startFn ?? startLoop;
  try {
    const root = await resolveLocalStoreDir(cwd); // the <root>/.opensquid dir; pid/lock live here (per-project)
    const cur = await statusFn(root);
    if (cur.running) return { status: 'already_running', pid: cur.pid };
    const lockPath = loopLockPath(root);
    if (await tryAcquireLock(lockPath)) {
      try {
        // Re-check after the lock — a peer may have finished spawning between our status() and the lock.
        const re = await statusFn(root);
        if (re.running) return { status: 'already_running', pid: re.pid };
        const res = await startFn(
          root,
          deps.entrypoint === undefined ? {} : { entrypoint: deps.entrypoint },
        );
        return { status: 'spawned', pid: res.pid };
      } finally {
        await fs.unlink(lockPath).catch(() => {
          /* race-tolerant */
        });
      }
    }
    // Another process holds the lock — wait for its pidfile.
    const pid = await waitForPeer(root, statusFn);
    return pid !== null
      ? { status: 'waited_for_peer', pid }
      : { status: 'error', error: 'peer spawn timed out' };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Atomic single-flight spawn-lock: `fs.open(lock,'wx')`, reclaiming a lock older than STALE_LOCK_AGE_MS.
 *  Copied 1:1 in shape from autospawn.ts:138-162 (the lockPath is now project-local). */
async function tryAcquireLock(lockPath: string): Promise<boolean> {
  await fs.mkdir(dirname(lockPath), { recursive: true });
  try {
    const fd = await fs.open(lockPath, 'wx');
    await fd.write(`${process.pid}\n`);
    await fd.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lock exists — reclaim it if stale, else yield.
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > STALE_LOCK_AGE_MS) {
        await fs.unlink(lockPath).catch(() => {
          /* race */
        });
        return tryAcquireLock(lockPath);
      }
    } catch {
      // Lock vanished between EEXIST and stat — retry.
      return tryAcquireLock(lockPath);
    }
    return false;
  }
}

/** A lock-loser waits for the winner's pidfile to appear (its liveness becomes observable). Mirrors
 *  autospawn.ts:164-172 with the project-local `statusFn`. */
async function waitForPeer(
  root: string,
  statusFn: (root: string) => Promise<LoopStatus>,
): Promise<number | null> {
  const deadline = Date.now() + PIDFILE_WAIT_MS;
  while (Date.now() < deadline) {
    const s = await statusFn(root);
    if (s.running) return s.pid;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/** Wait for the spawned worker to write its pidfile (with a live pid). Mirrors lifecycle.ts:190-203. */
async function waitForPidfile(pidFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(pidFile, 'utf8');
      const pid = parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) return pid;
    } catch {
      /* not yet written */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`loop-autospawn: worker did not write pidfile within ${timeoutMs}ms`);
}

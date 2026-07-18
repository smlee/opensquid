/**
 * Loop auto-spawn (T-auto-trigger-loop-on-scope-exit, ATL.1) — start-if-not-running for the gated-ralph loop.
 *
 * The loop analog of the chat-daemon autospawn (`src/channels/daemon/{autospawn,lifecycle}.ts`): a config-free
 * liveness gate → atomic single-flight spawn-lock → re-check → detached+`unref` spawn of `dist/cli.js loop` →
 * a loser waits for the winner's pidfile → NEVER throws. `ensureLoopRunning` is fired FAIL-OPEN from the shared
 * approved-handoff writer so a pack-declared interactive boundary can hand off to process-driven states without
 * a manual `opensquid loop` launch.
 *
 * ONE deliberate divergence from the chat-daemon precedent: the loop's pid + spawn-lock are PROJECT-LOCAL
 * (`<target-repo>/.opensquid/`), NOT machine-global (`OPENSQUID_HOME`). The target repository is explicit; it is
 * never inferred from the interactive harness's invocation cwd. A loop drives ONE project's project-local board
 * (commit `a023159` — "project-local state"), so liveness and the single-flight lock must be per-project: two
 * projects can each run their own loop without colliding. The chat-daemon's `anyChatConfigured` gate has NO loop
 * analog — a loop is drivable whenever the board has a ready item, so dropping the config gate is the correct
 * simplification (the liveness gate plus the caller's pack-aware admission check are sufficient).
 *
 * STAGE-BLIND by contract (ask Boundary: "core = the generic loop-trigger … no stage vocabulary"): this module
 * knows no pack state ids; the policy caller decides which durable transition triggers it.
 *
 * Imports from: node:child_process, node:fs, node:path, node:url, ../paths.
 * Imported by the approved-handoff boundary and tests.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync, promises as fs, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { resolveLocalStoreDir } from '../paths.js';
import { probeLoopOwner } from './loop_owner.js';

const OWNER_WAIT_MS = 8_000;
const READY_KIND = 'opensquid_loop_ready';
const READY_VERSION = 1;
const READY_LIMIT = 4_096;
const READY_FD_ENV = 'OPENSQUID_LOOP_READY_FD';
const CANDIDATE_TERM_GRACE_MS = 250;
const CANDIDATE_KILL_WAIT_MS = 2_000;
const CANDIDATE_REAP_POLL_MS = 25;

export type LoopReadyAnnouncement =
  | { readonly status: 'acquired' | 'occupied'; readonly pid: number }
  | { readonly status: 'error'; readonly error: string };

/** Push one startup result over the inherited one-shot descriptor. Manual loop launches have no descriptor. */
export function publishLoopReadiness(result: LoopReadyAnnouncement): void {
  const rawFd = process.env[READY_FD_ENV];
  if (rawFd === undefined) return;
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3) return;
  const line = `${JSON.stringify({
    kind: READY_KIND,
    version: READY_VERSION,
    status: result.status,
    ...(result.status === 'error' ? { error: result.error } : { pid: result.pid }),
  })}\n`;
  try {
    writeSync(fd, line, undefined, 'utf8');
  } catch {
    // The requester may have exited. Endpoint ownership remains authoritative and a retry probes it directly.
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

function decodeLoopReadiness(line: string): LoopReadyAnnouncement | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.kind !== READY_KIND || value.version !== READY_VERSION) return null;
    const keys = Object.keys(value);
    if (
      (value.status === 'acquired' || value.status === 'occupied') &&
      keys.join(',') === 'kind,version,status,pid' &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0
    ) {
      return { status: value.status, pid: Number(value.pid) };
    }
    if (
      value.status === 'error' &&
      keys.join(',') === 'kind,version,status,error' &&
      typeof value.error === 'string' &&
      value.error !== ''
    ) {
      return { status: 'error', error: value.error };
    }
    return null;
  } catch {
    return null;
  }
}

/** Await exactly one bounded readiness record; EOF, malformed data, and timeout fail closed. */
export function waitForLoopReadiness(
  stream: Readable,
  timeoutMs = OWNER_WAIT_MS,
): Promise<LoopReadyAnnouncement> {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    const finish = (error: Error | null, value?: LoopReadyAnnouncement): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      if (error !== null || value === undefined) reject(error ?? new Error('missing readiness'));
      else resolve(value);
    };
    const parseCompleteBody = (): void => {
      const newline = body.indexOf('\n');
      if (newline < 0) {
        finish(new Error('loop-autospawn: readiness descriptor ended early'));
        return;
      }
      if (body.slice(newline + 1) !== '') {
        finish(new Error('loop-autospawn: readiness descriptor carried trailing bytes'));
        return;
      }
      const value = decodeLoopReadiness(body.slice(0, newline));
      if (value === null) finish(new Error('loop-autospawn: malformed readiness record'));
      else finish(null, value);
    };
    const onData = (chunk: Buffer): void => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body, 'utf8') > READY_LIMIT) {
        finish(new Error('loop-autospawn: readiness record exceeded limit'));
        return;
      }
    };
    const onEnd = (): void => parseCompleteBody();
    const onClose = (): void => {
      if (!settled) finish(new Error('loop-autospawn: readiness descriptor closed before EOF'));
    };
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(
      () =>
        finish(
          new Error(`loop-autospawn: worker readiness timed out after ${String(timeoutMs)}ms`),
        ),
      timeoutMs,
    );
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

/** Same-process launch coalescing only. Cross-process correctness belongs to the worker-held kernel endpoint. */
const startsByStore = new Map<
  string,
  Promise<{ pid: number; status: 'spawned' | 'waited_for_peer' }>
>();

export type LoopStatus =
  | { running: true; pid: number; uptime_ms: number | null }
  | { running: false; error?: string };

export interface LoopAutoSpawnResult {
  status: 'spawned' | 'already_running' | 'waited_for_peer' | 'error';
  pid?: number;
  error?: string;
}

/** Explicit target repository plus its project-local OpenSquid state directory. */
export interface ResolvedLoopProject {
  readonly targetRepoRoot: string;
  readonly storeRoot: string;
}

/**
 * Resolve an explicitly selected repository. `targetRepoRoot` is not an invocation/session cwd: callers must
 * supply the repository the work item updates. Requiring an exact project root prevents a workspace parent or
 * nested directory from silently selecting a different `.opensquid` store.
 */
export async function resolveLoopProject(targetRepoRoot: string): Promise<ResolvedLoopProject> {
  const canonicalTarget = await fs.realpath(targetRepoRoot);
  const storeRoot = await fs.realpath(await resolveLocalStoreDir(canonicalTarget));
  if (dirname(storeRoot) !== canonicalTarget) {
    throw new Error(
      `loop-autospawn: target repository does not own the resolved store: ${canonicalTarget}`,
    );
  }
  return { targetRepoRoot: canonicalTarget, storeRoot };
}

/**
 * Probe the project-keyed kernel endpoint. The pidfile is only a repaired projection; it never establishes
 * liveness or admission. A connected but invalid endpoint is reported as an error and is never stale-reclaimed.
 */
export async function loopStatus(root: string): Promise<LoopStatus> {
  const project = { targetRepoRoot: dirname(root), storeRoot: root };
  const probe = await probeLoopOwner(project);
  if (probe.kind === 'live') return { running: true, pid: probe.owner.pid, uptime_ms: null };
  if (probe.kind === 'compromised') return { running: false, error: probe.error };
  return { running: false };
}

/** Resolve `dist/cli.js` from this module (dist/runtime/ralph/loop_autospawn.js → dist/cli.js). Test seam. */
export function resolveLoopEntrypoint(): string {
  const override = process.env.OPENSQUID_CLI_ENTRYPOINT;
  if (override !== undefined && override.length > 0) return override;
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), '..', '..', 'cli.js'); // dist/runtime/ralph → dist → dist/cli.js
}

/** Spawn the worker in the explicit target repository, then wait for its lifetime owner endpoint. */
export async function startLoop(
  project: ResolvedLoopProject,
  opts: {
    entrypoint?: string;
    nodeBin?: string;
    readyFn?: (project: ResolvedLoopProject, spawnedPid: number) => Promise<number>;
  } = {},
): Promise<{ pid: number; status: 'spawned' | 'waited_for_peer' }> {
  const { targetRepoRoot, storeRoot } = project;
  const cur = await loopStatus(storeRoot);
  if (cur.running) return { pid: cur.pid, status: 'waited_for_peer' };
  if (cur.error !== undefined) throw new Error(`loop-autospawn: ${cur.error}`);
  const logFile = resolve(storeRoot, 'loop.log');
  await fs.mkdir(dirname(logFile), { recursive: true });
  const childLogFd = openSync(logFile, 'a');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      opts.nodeBin ?? process.execPath,
      [opts.entrypoint ?? resolveLoopEntrypoint(), 'loop'],
      {
        cwd: targetRepoRoot,
        detached: true,
        stdio: ['ignore', childLogFd, childLogFd, 'pipe'],
        env: { ...process.env, [READY_FD_ENV]: '3' },
      },
    );
  } finally {
    closeSync(childLogFd);
  }
  child.unref();
  if (child.pid === undefined) throw new Error('loop-autospawn: spawn returned no pid');
  const readiness = child.stdio[3];
  if (!(readiness instanceof Readable)) {
    throw new Error('loop-autospawn: spawn returned no readiness descriptor');
  }
  try {
    const workerPid =
      opts.readyFn === undefined
        ? await waitForLoopOwner(project, child.pid, readiness)
        : await opts.readyFn(project, child.pid).finally(() => readiness.destroy());
    return {
      pid: workerPid,
      status: workerPid === child.pid ? 'spawned' : 'waited_for_peer',
    };
  } catch (error) {
    await reclaimCandidate(child.pid, child);
    throw error;
  }
}

export interface EnsureLoopRunningDeps {
  /** Override the spawned worker's entrypoint (defaults to `dist/cli.js`). */
  entrypoint?: string;
  /** Override the liveness probe (defaults to `loopStatus`). */
  statusFn?: (root: string) => Promise<LoopStatus>;
  /** Override the spawn (defaults to `startLoop`). */
  startFn?: (
    project: ResolvedLoopProject,
    opts: { entrypoint?: string },
  ) => Promise<{ pid: number; status?: 'spawned' | 'waited_for_peer' }>;
}

/**
 * Best-effort: ensure a loop is running for the explicitly selected target repository. Idempotent
 * (already-running → no spawn), single-flight (concurrent callers spawn at most one), and NEVER throws.
 */
export async function ensureLoopRunning(
  targetRepoRoot: string,
  deps: EnsureLoopRunningDeps = {},
): Promise<LoopAutoSpawnResult> {
  const statusFn = deps.statusFn ?? loopStatus;
  const startFn = deps.startFn ?? startLoop;
  try {
    const project = await resolveLoopProject(targetRepoRoot);
    const { storeRoot } = project;
    const cur = await statusFn(storeRoot);
    if (cur.running) return { status: 'already_running', pid: cur.pid };
    if (cur.error !== undefined) return { status: 'error', error: cur.error };
    const inFlight = startsByStore.get(storeRoot);
    if (inFlight !== undefined) {
      const peer = await inFlight;
      return { status: 'waited_for_peer', pid: peer.pid };
    }
    const start = (async (): Promise<{
      pid: number;
      status: 'spawned' | 'waited_for_peer';
    }> => {
      const re = await statusFn(storeRoot);
      if (re.running) return { status: 'waited_for_peer', pid: re.pid };
      if (re.error !== undefined) throw new Error(re.error);
      const result = await startFn(
        project,
        deps.entrypoint === undefined ? {} : { entrypoint: deps.entrypoint },
      );
      return { pid: result.pid, status: result.status ?? 'spawned' };
    })();
    startsByStore.set(storeRoot, start);
    try {
      const result = await start;
      return { status: result.status, pid: result.pid };
    } finally {
      if (startsByStore.get(storeRoot) === start) startsByStore.delete(storeRoot);
    }
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Reclaim only the candidate group this caller spawned after an invalid/missing readiness result. */
async function reclaimCandidate(pid: number, child: ReturnType<typeof spawn>): Promise<void> {
  const target = process.platform === 'win32' ? pid : -pid;
  const alive = (): boolean => {
    try {
      process.kill(target, 0);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (kind: NodeJS.Signals): void => {
    try {
      if (process.platform === 'win32') child.kill(kind);
      else process.kill(target, kind);
    } catch {
      /* already exited */
    }
  };
  signal('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, CANDIDATE_TERM_GRACE_MS));
  if (!alive()) return;
  signal('SIGKILL');
  const deadline = Date.now() + CANDIDATE_KILL_WAIT_MS;
  while (alive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CANDIDATE_REAP_POLL_MS));
  }
  if (alive()) {
    throw new Error(
      `loop-autospawn: candidate tree remained live ${String(CANDIDATE_KILL_WAIT_MS)}ms after SIGKILL`,
    );
  }
}

/** Read the pushed startup result, then validate it once against the authoritative lifetime endpoint. */
async function waitForLoopOwner(
  project: ResolvedLoopProject,
  spawnedPid: number,
  readiness: Readable,
): Promise<number> {
  const announced = await waitForLoopReadiness(readiness);
  if (announced.status === 'error') throw new Error(`loop-autospawn: ${announced.error}`);
  if (announced.status === 'acquired' && announced.pid !== spawnedPid) {
    throw new Error('loop-autospawn: acquired readiness pid did not match the spawned candidate');
  }
  const probe = await probeLoopOwner(project);
  if (probe.kind === 'compromised') throw new Error(`loop-autospawn: ${probe.error}`);
  if (probe.kind !== 'live') {
    throw new Error('loop-autospawn: readiness arrived without a live owner endpoint');
  }
  if (probe.owner.pid !== announced.pid) {
    throw new Error('loop-autospawn: readiness pid did not match the owner handshake');
  }
  return probe.owner.pid;
}

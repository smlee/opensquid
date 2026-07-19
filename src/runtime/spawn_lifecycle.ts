/**
 * Harness-neutral one-shot subprocess transport.
 *
 * This helper OWNS each one-shot child tree until it exits. Timeout/capture failure closes stdin, sends SIGTERM,
 * and arms a bounded grace period followed by an exact process-group SIGKILL. A synchronous supervisor-exit
 * handler closes the timer gap when a short-lived hook calls `process.exit()` after the promise rejects.
 * `OPENSQUID_SUPERVISED` keeps nested helpers in the outermost owned group so descendants cannot escape cleanup.
 */

import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';

/**
 * Injectable process-control surfaces `runOneShotCli` touches — default binds
 * the real `node:child_process` spawn / global `process.kill` / global timers /
 * `process` exit-hook. Mirrors the StageIo DI convention
 * (release/stage_integration.ts:20): a single bundled seam object with a
 * `real*` default binding. An omitted `procControl` ⇒ `realProcControl` ⇒
 * production is byte-for-byte unchanged; a test injects a recording fake to
 * exercise timeout/shutdown behavior hermetically without a real subprocess.
 */
export interface ProcControl {
  /** Returns a piped-stdio child (runOneShotCli always spawns with `stdio: ['pipe','pipe','pipe']`, so the three
   *  streams are non-null — the `WithoutNullStreams` variant, matching the concrete real-`spawn` overload). */
  spawn: (cli: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
  /** Signal an exact owned process or process group; detached POSIX groups use a negative pid. */
  kill: (pid: number, signal: NodeJS.Signals | number) => void;
  /** Optional platform owner override (for example, an exact Windows Job Object). */
  signalTree?: (
    proc: ChildProcessWithoutNullStreams,
    detached: boolean,
    signal: 'SIGTERM' | 'SIGKILL',
  ) => void | Promise<void>;
  /** Exact owned-tree liveness after the root closes. Omitted by hermetic fakes that settle on close. */
  isTreeAlive?: (proc: ChildProcessWithoutNullStreams, detached: boolean) => boolean;
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (t: NodeJS.Timeout | undefined) => void;
  onExit: (fn: () => void) => void;
  offExit: (fn: () => void) => void;
}

/**
 * The default real ProcControl — LAZY pass-throughs (each member calls the
 * global at CALL time, e.g. `globalThis.setTimeout(fn, ms)`), so (a) an omitted
 * `procControl` is byte-for-byte production behavior and (b) a test's
 * `vi.useFakeTimers()` (which patches the globals) transparently drives the
 * default timers. Do NOT eager-capture a global (`setTimeout: globalThis.setTimeout`)
 * — that would freeze the ORIGINAL timer and silently defeat fake timers.
 */
export const realProcControl: ProcControl = {
  // The generic-SpawnOptions overload of `spawn` widens to ChildProcess; runOneShotCli always passes piped
  // stdio, so the streams are non-null — narrow to the WithoutNullStreams variant the seam contract promises.
  spawn: (cli, args, options) => spawn(cli, args, options) as ChildProcessWithoutNullStreams,
  kill: (pid, signal) => process.kill(pid, signal),
  signalTree: (proc, detached, signal) => {
    if (detached && typeof proc.pid === 'number' && process.platform !== 'win32') {
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
  },
  isTreeAlive: (proc, detached) => {
    if (typeof proc.pid !== 'number') return false;
    try {
      process.kill(detached && process.platform !== 'win32' ? -proc.pid : proc.pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => {
    if (t !== undefined) globalThis.clearTimeout(t);
  },
  onExit: (fn) => void process.once('exit', fn),
  offExit: (fn) => void process.removeListener('exit', fn),
};

export interface OneShotOpts {
  cli: string;
  args: string[];
  /** Child working directory. Omitted ⇒ inherit the current process cwd. */
  cwd?: string;
  /** Prompt body written to the child's stdin then EOF. */
  prompt: string;
  timeoutMs: number;
  /** SUB.1 hook-policy marker: reviewer spawns mark the child tree; bridge spawns + ralph laps do not (a lap
   *  publishes the orthogonal recursion-only OPENSQUID_LOOP_LAP marker via `env` instead). Optional: omitted ⇒
   *  not silenced (falsy at :158). */
  markSubagent?: boolean;
  /** Typed rejection factory — each site keeps its own timeout error contract. */
  timeoutError: (timeoutMs: number) => Error;
  /** Prefix for spawn/exit/stdin error messages (bridge: 'subscription cli '). */
  errorPrefix?: string;
  /** Grace after SIGTERM before the exact owned process group is SIGKILLed. Default 5_000 ms. */
  graceMs?: number;
  /** Observe the automatic shutdown request before signals are sent (e.g. durable executor status). */
  onShutdownRequested?: () => void | Promise<void>;
  /** Max BYTES retained per captured stream (stdout AND stderr, independently). A runaway lap that exceeds this
   *  is FAILED-LOUD and the owned child tree is reclaimed — NOT silently truncated
   *  (a truncated JSONL stream would corrupt the fold, codex_lap_harness.ts:99). Default 10 MiB. */
  maxCaptureBytes?: number;
  /** Extra env vars merged OVER the inherited process env for the child (e.g. OPENSQUID_ITEM_ID for a ralph lap). */
  env?: NodeJS.ProcessEnv;
  /**
   * Best-effort observer of BOTH captured streams at process close / spawn-error (ANY exit code) — so the
   * caller can LOG the subprocess's stdout/stderr/exit regardless of outcome (a wedged/crashed lap is then
   * diagnosable). Called at most once; never affects the returned result.
   */
  onStreams?: (s: { stdout: string; stderr: string; code: number | null }) => void;
  /**
   * LIVE per-line observer of the child's stderr, called as each complete line arrives (not buffered until
   * close) — the basic subprocess→parent message channel. The child writes a progress line to stderr; the
   * parent sees it immediately and can surface it. No chat, no daemon, no log-scraping.
   */
  onStderrLine?: (line: string) => void;
  /**
   * Injected process-control seam (spawn / kill / timers / exit-hook). Omitted ⇒ `realProcControl` ⇒ production
   * unchanged; a hermetic test injects a recording fake to drive the lifecycle FSM with no real subprocess.
   */
  procControl?: ProcControl;
}

type LifecyclePhase = 'running' | 'spawn_failed' | 'term_sent' | 'closed' | 'tree_killed';

export class OwnedProcessCleanupError extends Error {
  readonly cause: Error;

  constructor(message: string, cause: Error) {
    super(message);
    this.name = 'OwnedProcessCleanupError';
    this.cause = cause;
  }
}

export function isOwnedProcessCleanupError(error: unknown): error is OwnedProcessCleanupError {
  return error instanceof OwnedProcessCleanupError;
}

/**
 * One OOP owner for the shutdown state machine shared by one-shot and duplex transports.
 * A failure requests TERM once, escalates once, and does not settle until root close plus exact-tree drain.
 */
export class OwnedProcess {
  private phase: LifecyclePhase = 'running';
  private shutdownError: Error | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private forceKillPromise: Promise<void> | undefined;
  private finalError: Error | undefined;

  private readonly exitKill = (): void => {
    // Exit hooks are synchronous. Killing the broker/root is the final fallback; POSIX exact-group and Windows
    // Job control are also invoked through forceKill(). Windows brokers set KILL_ON_JOB_CLOSE.
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    void this.forceKill();
  };

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly detached: boolean,
    private readonly pc: ProcControl,
    private readonly options: {
      graceMs?: number;
      treeExitTimeoutMs?: number;
      closeInput: () => void;
      onShutdownRequested?: () => void | Promise<void>;
    },
  ) {}

  get shutdownPending(): boolean {
    return this.phase === 'term_sent' || this.phase === 'tree_killed';
  }

  requestShutdown(error: Error): boolean {
    if (this.phase !== 'running') return false;
    this.phase = 'term_sent';
    this.shutdownError = error;
    void Promise.resolve(this.options.onShutdownRequested?.()).catch(() => undefined);
    try {
      this.options.closeInput();
    } catch {
      /* stdin may already be closed */
    }
    this.sendSignal('SIGTERM');
    this.pc.onExit(this.exitKill);
    this.graceTimer = this.pc.setTimeout(
      () => void this.forceKill(),
      this.options.graceMs ?? 5_000,
    );
    return true;
  }

  async handleSpawnError(error: Error): Promise<Error> {
    if (this.phase === 'closed' || this.phase === 'spawn_failed') {
      return this.finalError ?? this.shutdownError ?? error;
    }
    const wasShuttingDown = this.shutdownPending;
    if (wasShuttingDown) await this.forceKill();
    this.phase = 'spawn_failed';
    this.cleanup();
    this.finalError = this.shutdownError ?? error;
    return this.finalError;
  }

  async handleClose(): Promise<Error | undefined> {
    if (this.phase === 'closed' || this.phase === 'spawn_failed') return this.finalError;
    if (this.phase === 'term_sent') await this.forceKill();
    else if (this.phase === 'tree_killed') await this.forceKillPromise;
    const failedToDrain = this.shutdownPending && !(await this.waitForTreeExit());
    this.phase = 'closed';
    this.cleanup();
    if (failedToDrain) {
      const cause = this.shutdownError ?? new Error('owned subprocess shutdown');
      this.finalError = new OwnedProcessCleanupError(
        `owned subprocess tree remained live after ${String(this.options.treeExitTimeoutMs ?? 2_000)}ms`,
        cause,
      );
    } else {
      this.finalError = this.shutdownError;
    }
    return this.finalError;
  }

  private sendSignal(signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      const result =
        this.pc.signalTree?.(this.proc, this.detached, signal) ??
        (this.detached && typeof this.proc.pid === 'number' && process.platform !== 'win32'
          ? this.pc.kill(-this.proc.pid, signal)
          : this.proc.kill(signal));
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      /* forceKill + exact liveness verification remain authoritative */
    }
  }

  private forceKill(): Promise<void> {
    if (this.forceKillPromise !== undefined) return this.forceKillPromise;
    if (this.phase === 'closed' || this.phase === 'spawn_failed') return Promise.resolve();
    this.phase = 'tree_killed';
    this.pc.offExit(this.exitKill);
    if (this.graceTimer !== undefined) this.pc.clearTimeout(this.graceTimer);
    this.forceKillPromise = (async () => {
      try {
        const result = this.pc.signalTree?.(this.proc, this.detached, 'SIGKILL');
        if (result !== undefined) await result;
        else if (
          this.detached &&
          typeof this.proc.pid === 'number' &&
          process.platform !== 'win32'
        ) {
          this.pc.kill(-this.proc.pid, 'SIGKILL');
        } else {
          this.proc.kill('SIGKILL');
        }
      } catch {
        /* exact liveness verification below determines whether cleanup succeeded */
      }
    })();
    return this.forceKillPromise;
  }

  private async waitForTreeExit(): Promise<boolean> {
    if (this.pc.isTreeAlive === undefined) return true;
    const deadline = Date.now() + (this.options.treeExitTimeoutMs ?? 2_000);
    while (this.pc.isTreeAlive(this.proc, this.detached)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        this.pc.setTimeout(resolve, Math.min(25, remaining));
      });
    }
    return true;
  }

  private cleanup(): void {
    this.pc.offExit(this.exitKill);
    if (this.graceTimer !== undefined) this.pc.clearTimeout(this.graceTimer);
  }
}

/** Kill-tree marker: true when THIS process already runs under a helper-supervised tree. */
export const insideSupervisedTree = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.OPENSQUID_SUPERVISED === '1';

/** Default per-stream capture cap (10 MiB) — generous for any normal lap, operator-overridable via
 *  OneShotOpts.maxCaptureBytes. A runaway lap that spews past it is failed-loud (§5-Q2), not truncated. */
export const DEFAULT_CLI_CAPTURE_BYTES = 10 * 1024 * 1024;

export function runOneShotCli(opts: OneShotOpts): Promise<string> {
  const prefix = opts.errorPrefix ?? '';
  const pc = opts.procControl ?? realProcControl; // omitted ⇒ real impls ⇒ prod byte-unchanged
  const cap = opts.maxCaptureBytes ?? DEFAULT_CLI_CAPTURE_BYTES;
  return new Promise<string>((resolve, reject) => {
    // Detach predicate = the SUPERVISED marker, NOT the hook-policy marker
    // (spec-audit finding 1): a reviewer spawned from an UNMARKED bridge
    // tree must still join the bridge group, or it escapes the sweep. Every
    // helper spawn sets SUPERVISED; only the outermost detaches.
    const detached = !insideSupervisedTree();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENSQUID_SUPERVISED: '1',
      ...(opts.markSubagent ? { OPENSQUID_SUBAGENT: '1' } : {}),
      ...(opts.env ?? {}), // per-spawn overrides (e.g. OPENSQUID_ITEM_ID) — last so they win
    };
    const proc = pc.spawn(opts.cli, opts.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
      env,
    });

    let stdout = '';
    let stderr = '';
    let stderrLineBuf = ''; // carries a partial (un-newlined) tail between data chunks for onStderrLine
    let stdoutBytes = 0; // TRUE byte counters (incoming Buffer.length), not UTF-16 string length
    let stderrBytes = 0;
    let streamsReported = false;
    let terminal = false;
    const reportStreams = (code: number | null): void => {
      if (streamsReported) return;
      streamsReported = true;
      opts.onStreams?.({ stdout, stderr, code });
    };
    const owner = new OwnedProcess(proc, detached, pc, {
      ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
      closeInput: () => proc.stdin.end(),
      ...(opts.onShutdownRequested === undefined
        ? {}
        : { onShutdownRequested: opts.onShutdownRequested }),
    });
    const requestShutdown = (error: Error): void => {
      if (owner.requestShutdown(error)) pc.clearTimeout(timer);
    };
    const timer = pc.setTimeout(
      () => requestShutdown(opts.timeoutError(opts.timeoutMs)),
      opts.timeoutMs,
    );

    // Fail-loud on a runaway stream and reclaim the same owned tree through the one shutdown seam.
    const failCapExceeded = (stream: 'stdout' | 'stderr'): void => {
      requestShutdown(
        new Error(
          `${prefix}capture cap exceeded: ${stream} exceeded ${cap} bytes ` +
            `(runaway lap — fail-loud, not truncated; raise OneShotOpts.maxCaptureBytes to override)`,
        ),
      );
    };

    proc.stdout.on('data', (d: Buffer) => {
      stdoutBytes += d.length; // TRUE byte length of the incoming chunk (not UTF-16 string length)
      if (stdoutBytes > cap) return failCapExceeded('stdout'); // > cap: a stream exactly at the cap passes
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes > cap) return failCapExceeded('stderr'); // drop the chunk — no append, no onStderrLine drain
      const chunk = d.toString('utf8');
      stderr += chunk;
      if (opts.onStderrLine !== undefined) {
        stderrLineBuf += chunk;
        for (let nl = stderrLineBuf.indexOf('\n'); nl >= 0; nl = stderrLineBuf.indexOf('\n')) {
          const line = stderrLineBuf.slice(0, nl);
          stderrLineBuf = stderrLineBuf.slice(nl + 1);
          if (line.length > 0) opts.onStderrLine(line); // deliver each COMPLETE line live to the parent
        }
      }
    });

    proc.on('error', (e) => {
      if (terminal) return;
      terminal = true;
      pc.clearTimeout(timer);
      reportStreams(null);
      void owner
        .handleSpawnError(new Error(`${prefix}spawn failed: ${e.message}`))
        .then(reject, reject);
    });

    proc.on('close', (code) => {
      if (terminal) return;
      terminal = true;
      pc.clearTimeout(timer);
      reportStreams(code); // best-effort stream capture for logging (any exit code), exactly once
      void owner.handleClose().then((shutdownError) => {
        if (shutdownError !== undefined) reject(shutdownError);
        else if (code === 0) resolve(stdout);
        else reject(new Error(`${prefix}exit ${code}: ${stderr.trim()}`));
      }, reject);
    });

    try {
      proc.stdin.write(opts.prompt);
      proc.stdin.end();
    } catch (e) {
      requestShutdown(new Error(`${prefix}stdin write failed: ${String(e)}`));
    }
  });
}

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
  /** Signal an exact owned process or process group; detached groups use a negative pid. */
  kill: (pid: number, signal: NodeJS.Signals | number) => void;
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

type LifecyclePhase =
  | { phase: 'running' }
  | { phase: 'spawn_failed' }
  | { phase: 'term_sent' }
  | { phase: 'closed' }
  | { phase: 'group_killed' };

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

    let state: LifecyclePhase = { phase: 'running' };
    let stdout = '';
    let stderr = '';
    let stderrLineBuf = ''; // carries a partial (un-newlined) tail between data chunks for onStderrLine
    let stdoutBytes = 0; // TRUE byte counters (incoming Buffer.length), not UTF-16 string length
    let stderrBytes = 0;
    let graceTimer: NodeJS.Timeout | undefined;
    let shutdownError: Error | undefined;
    let streamsReported = false;
    const reportStreams = (code: number | null): void => {
      if (streamsReported) return;
      streamsReported = true;
      opts.onStreams?.({ stdout, stderr, code });
    };

    const groupKill = (): void => {
      if (state.phase !== 'term_sent') return;
      state = { phase: 'group_killed' };
      pc.offExit(exitKill);
      if (graceTimer !== undefined) pc.clearTimeout(graceTimer);
      try {
        if (detached && typeof proc.pid === 'number' && process.platform !== 'win32') {
          pc.kill(-proc.pid, 'SIGKILL');
        } else {
          proc.kill('SIGKILL');
        }
      } catch {
        /* ESRCH / already reaped */
      }
    };

    // A hook process can call process.exit() before the grace timer runs. Exit handlers are synchronous, so
    // reclaim the owned group here rather than orphaning it when the supervisor disappears.
    const exitKill = (): void => groupKill();

    const requestShutdown = (error: Error): void => {
      if (state.phase !== 'running') return;
      state = { phase: 'term_sent' };
      shutdownError = error;
      pc.clearTimeout(timer);
      void Promise.resolve(opts.onShutdownRequested?.()).catch(() => undefined);
      try {
        proc.stdin.end();
      } catch {
        /* stdin may already be closed */
      }
      try {
        if (detached && typeof proc.pid === 'number' && process.platform !== 'win32') {
          pc.kill(-proc.pid, 'SIGTERM');
        } else {
          proc.kill('SIGTERM');
        }
      } catch {
        /* close/group cleanup remains authoritative */
      }
      pc.onExit(exitKill);
      graceTimer = pc.setTimeout(groupKill, opts.graceMs ?? 5_000);
      // Settle from process close only, so the caller cannot retry while the prior owned tree is still alive.
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
      if (state.phase === 'closed' || state.phase === 'spawn_failed') return;
      state = { phase: 'spawn_failed' };
      pc.clearTimeout(timer);
      if (graceTimer !== undefined) pc.clearTimeout(graceTimer);
      pc.offExit(exitKill);
      reportStreams(null);
      reject(shutdownError ?? new Error(`${prefix}spawn failed: ${e.message}`));
    });

    proc.on('close', (code) => {
      if (state.phase === 'closed' || state.phase === 'spawn_failed') return;
      reportStreams(code); // best-effort stream capture for logging (any exit code), exactly once
      if (state.phase === 'running') {
        state = { phase: 'closed' };
        pc.clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${prefix}exit ${code}: ${stderr.trim()}`));
      } else if (state.phase === 'term_sent') {
        // The root closing does not prove its detached descendants exited. Sweep the exact group before settling;
        // ESRCH is harmless when SIGTERM already emptied the group.
        groupKill();
        state = { phase: 'closed' };
        reject(shutdownError ?? new Error(`${prefix}subprocess shutdown`));
      } else if (state.phase === 'group_killed') {
        state = { phase: 'closed' };
        reject(shutdownError ?? new Error(`${prefix}subprocess shutdown`));
      }
    });

    try {
      proc.stdin.write(opts.prompt);
      proc.stdin.end();
    } catch (e) {
      requestShutdown(new Error(`${prefix}stdin write failed: ${String(e)}`));
    }
  });
}

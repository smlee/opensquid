/**
 * Harness-neutral one-shot subprocess transport.
 *
 * Automatic timeout and capture-bound handling reject the invocation and request graceful stdin shutdown only.
 * This module never sends SIGTERM/SIGKILL; supervisor-owned process identity and explicit human OS actions live
 * in `runtime/subagents/process_control.ts`. `OPENSQUID_SUPERVISED` still prevents nested helpers from creating
 * accidental process groups, while an outer harness owner may create an exact group for human control.
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
  /** Explicit human process control uses this seam; automatic transports do not call it. */
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
  /** Observe an automatic protocol-level shutdown request. Automatic supervision never sends an OS signal. */
  onShutdownRequested?: () => void | Promise<void>;
  /** Max BYTES retained per captured stream (stdout AND stderr, independently). A runaway lap that exceeds this
   *  is FAILED-LOUD — the promise rejects and requests graceful shutdown — NOT silently truncated
   *  (a truncated JSONL stream would corrupt the fold, codex_lap_harness.ts:99). Default 10 MiB.
   *  Sibling to graceMs; omitted ⇒ the default ⇒ every existing caller is byte-unchanged. Harness-neutral. */
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
  | { phase: 'closed_late' };

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
    const requestShutdown = (error: Error): void => {
      if (state.phase !== 'running') return;
      state = { phase: 'term_sent' };
      void Promise.resolve(opts.onShutdownRequested?.()).catch(() => undefined);
      try {
        proc.stdin.end();
      } catch {
        // The process remains visible to the human control plane.
      }
      reject(error);
    };

    const timer = pc.setTimeout(
      () => requestShutdown(opts.timeoutError(opts.timeoutMs)),
      opts.timeoutMs,
    );

    // Fail-loud on a runaway stream without turning a resource bound into automatic OS authority.
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
      if (state.phase !== 'running') return;
      state = { phase: 'spawn_failed' };
      pc.clearTimeout(timer);
      opts.onStreams?.({ stdout, stderr, code: null });
      reject(new Error(`${prefix}spawn failed: ${e.message}`));
    });

    proc.on('close', (code) => {
      opts.onStreams?.({ stdout, stderr, code }); // best-effort stream capture for logging (any exit code)
      if (state.phase === 'running') {
        state = { phase: 'closed' };
        pc.clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${prefix}exit ${code}: ${stderr.trim()}`));
      } else if (state.phase === 'term_sent') {
        state = { phase: 'closed_late' };
      }
      // closed / spawn_failed / closed_late: terminal — nothing to do.
    });

    try {
      proc.stdin.write(opts.prompt);
      proc.stdin.end();
    } catch (e) {
      if (state.phase === 'running') {
        state = { phase: 'spawn_failed' };
        pc.clearTimeout(timer);
        reject(new Error(`${prefix}stdin write failed: ${String(e)}`));
      }
    }
  });
}

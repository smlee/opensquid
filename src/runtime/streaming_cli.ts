/**
 * Harness-neutral supervised duplex JSONL transport.
 *
 * This module owns process lifetime, byte caps, UTF-8/LF framing and stdin
 * backpressure. It deliberately knows nothing about any harness protocol.
 */
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  DEFAULT_CLI_CAPTURE_BYTES,
  insideSupervisedTree,
  realProcControl,
  type ProcControl,
} from './spawn_lifecycle.js';

export type TerminalDecision = 'continue' | 'complete' | { fail: Error };

export interface StreamingRecordContext {
  send(record: string): Promise<void>;
  complete(): void;
  fail(error: Error): void;
}

export interface StreamingCliOptions {
  cli: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  processGroup?: 'auto' | 'own';
  /** Observe an automatic EOF shutdown request (for the shared process-control read model). */
  onShutdownRequested?: () => void | Promise<void>;
  maxRecordBytes?: number;
  maxCaptureBytes?: number;
  /** Retain raw stdout in the result and apply maxCaptureBytes to it. Records are still framed and dispatched when false. */
  retainStdout?: boolean;
  onStart?: (ctx: StreamingRecordContext) => void | Promise<void>;
  onRecord(
    record: string,
    ctx: StreamingRecordContext,
  ): TerminalDecision | Promise<TerminalDecision>;
  onStderrLine?: (line: string) => void;
  onStreams?: (streams: { stdout: string; stderr: string; code: number | null }) => void;
  procControl?: ProcControl;
}

export interface StreamingCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  completed: boolean;
}

const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;

/** Stateful, serialized write side of a duplex CLI session. */
export class StreamingCliSession implements StreamingRecordContext {
  #phase: 'running' | 'input_closed' | 'failed' | 'closed' = 'running';
  #writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly onComplete: () => void,
    private readonly onFail: (error: Error) => void,
  ) {}

  get phase(): 'running' | 'input_closed' | 'failed' | 'closed' {
    return this.#phase;
  }

  send(record: string): Promise<void> {
    if (this.#phase !== 'running') return Promise.reject(new Error('stream input is closed'));
    this.#writeChain = this.#writeChain.then(() => this.writeWithDrain(`${record}\n`));
    return this.#writeChain;
  }

  closeInput(): void {
    if (this.#phase !== 'running') return;
    this.#phase = 'input_closed';
    this.proc.stdin.end();
  }

  complete(): void {
    if (this.#phase !== 'running') return;
    this.closeInput();
    this.onComplete();
  }

  fail(error: Error): void {
    if (this.#phase !== 'running') return;
    this.#phase = 'failed';
    this.proc.stdin.end();
    this.onFail(error);
  }

  markClosed(): void {
    this.#phase = 'closed';
  }

  async writesSettled(): Promise<void> {
    await this.#writeChain;
  }

  private async writeWithDrain(text: string): Promise<void> {
    if (this.#phase !== 'running') throw new Error('stream input is closed');
    let accepted: boolean;
    try {
      accepted = this.proc.stdin.write(text);
    } catch (error) {
      throw new Error(
        `stream stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (accepted) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new Error(`stream stdin write failed: ${error.message}`));
      };
      const cleanup = (): void => {
        this.proc.stdin.removeListener('drain', onDrain);
        this.proc.stdin.removeListener('error', onError);
      };
      this.proc.stdin.once('drain', onDrain);
      this.proc.stdin.once('error', onError);
    });
  }
}

/**
 * Spawn a supervised duplex process and dispatch only LF-terminated records.
 * A trailing unterminated fragment is captured but never dispatched.
 */
export function runStreamingCli(opts: StreamingCliOptions): Promise<StreamingCliResult> {
  const pc = opts.procControl ?? realProcControl;
  const captureCap = opts.maxCaptureBytes ?? DEFAULT_CLI_CAPTURE_BYTES;
  const recordCap = opts.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  const retainStdout = opts.retainStdout ?? true;
  const processGroup = opts.processGroup ?? 'auto';
  const ownProcessGroup = processGroup === 'own' && process.platform !== 'win32';

  return new Promise<StreamingCliResult>((resolve, reject) => {
    const detached = processGroup === 'own' ? ownProcessGroup : !insideSupervisedTree();
    const proc = pc.spawn(opts.cli, opts.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached,
      env: { ...process.env, OPENSQUID_SUPERVISED: '1', ...(opts.env ?? {}) },
    });

    let phase: 'running' | 'shutdown_pending' | 'terminal' = 'running';
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let currentRecordBytes = 0;
    let stdoutLine = '';
    let stderrLine = '';
    let callbackChain = Promise.resolve();
    let callbackError: Error | undefined;
    let completed = false;
    let streamsReported = false;
    const decoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const reportStreams = (code: number | null): void => {
      if (streamsReported) return;
      streamsReported = true;
      opts.onStreams?.({ stdout, stderr, code });
    };
    const beginShutdown = (error: Error): void => {
      if (phase !== 'running') return;
      phase = 'shutdown_pending';
      callbackError = error;
      pc.clearTimeout(timeoutTimer);
      // Automatic supervision is protocol-only. The owned process remains visible to the human control plane if
      // EOF does not stop it; this transport never sends an OS signal on timeout, cancellation, or capture caps.
      session.closeInput();
      void Promise.resolve(opts.onShutdownRequested?.()).catch(() => undefined);
      reject(error);
    };

    const session = new StreamingCliSession(
      proc,
      () => {
        completed = true;
      },
      (error) => {
        callbackError ??= error;
      },
    );
    const context: StreamingRecordContext = session;

    const timeoutTimer = pc.setTimeout(
      () => beginShutdown(Object.assign(new Error('streaming cli timeout'), { __timeout: true })),
      opts.timeoutMs,
    );

    const dispatch = (record: string): void => {
      callbackChain = callbackChain
        .then(async () => {
          const decision = await opts.onRecord(record, context);
          if (decision === 'complete') session.complete();
          else if (typeof decision === 'object') session.fail(decision.fail);
        })
        .catch((error: unknown) => {
          session.fail(error instanceof Error ? error : new Error(String(error)));
        });
    };

    // Framing uses its own incremental buffer so protocol consumers may discard raw stdout without changing
    // record delivery. This is useful for verbose RPC streams whose individual records are bounded but whose
    // complete wire transcript is not a useful result artifact.
    proc.stdout.on('data', (chunk: Buffer | string) => {
      if (phase !== 'running') return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (retainStdout) {
        stdoutBytes += bytes.length;
        if (stdoutBytes > captureCap) {
          beginShutdown(new Error(`capture cap exceeded: stdout exceeded ${captureCap} bytes`));
          return;
        }
      }
      for (const byte of bytes) {
        if (byte === 0x0a) currentRecordBytes = 0;
        else if (++currentRecordBytes > recordCap) {
          beginShutdown(
            new Error(`record cap exceeded: stdout record exceeded ${recordCap} bytes`),
          );
          return;
        }
      }
      const text = decoder.write(bytes);
      if (retainStdout) stdout += text;
      stdoutLine += text;
      for (let nl = stdoutLine.indexOf('\n'); nl >= 0; nl = stdoutLine.indexOf('\n')) {
        let record = stdoutLine.slice(0, nl);
        stdoutLine = stdoutLine.slice(nl + 1);
        if (record.endsWith('\r')) record = record.slice(0, -1);
        dispatch(record);
      }
    });

    proc.stderr.on('data', (chunk: Buffer | string) => {
      if (phase !== 'running') return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      stderrBytes += bytes.length;
      if (stderrBytes > captureCap) {
        beginShutdown(new Error(`capture cap exceeded: stderr exceeded ${captureCap} bytes`));
        return;
      }
      const text = stderrDecoder.write(bytes);
      stderr += text;
      stderrLine += text;
      for (let nl = stderrLine.indexOf('\n'); nl >= 0; nl = stderrLine.indexOf('\n')) {
        let line = stderrLine.slice(0, nl);
        stderrLine = stderrLine.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.length > 0) opts.onStderrLine?.(line);
      }
    });

    proc.on('error', (error) => {
      if (phase !== 'running') return;
      phase = 'terminal';
      pc.clearTimeout(timeoutTimer);
      reportStreams(null);
      reject(new Error(`streaming cli spawn failed: ${error.message}`));
    });

    proc.on('close', (code) => {
      const stdoutTail = decoder.end();
      const stderrTail = stderrDecoder.end();
      if (retainStdout) stdout += stdoutTail;
      stderr += stderrTail;
      reportStreams(code);
      if (phase === 'shutdown_pending') {
        session.markClosed();
        return;
      }
      if (phase !== 'running') return;
      phase = 'terminal';
      pc.clearTimeout(timeoutTimer);
      session.markClosed();
      void callbackChain.then(async () => {
        await session.writesSettled().catch((error: unknown) => {
          callbackError ??= error instanceof Error ? error : new Error(String(error));
        });
        if (callbackError !== undefined) reject(callbackError);
        else if (code !== 0)
          reject(new Error(`streaming cli exit ${String(code)}: ${stderr.trim()}`));
        else resolve({ stdout, stderr, code, completed });
      });
    });

    Promise.resolve(opts.onStart?.(context)).catch((error: unknown) => {
      session.fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

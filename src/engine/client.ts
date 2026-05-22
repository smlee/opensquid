/**
 * JSON-RPC 2.0 client for the loop-engine subprocess.
 *
 * Spawns `loop-engine serve` over stdio + line-framed JSON. One persistent
 * subprocess per `EngineClient` instance, lazily started on first call,
 * respawned after external exit (#170 regression guard).
 *
 * Critical invariants (T.1.D, T.1.CC, T.1.E, T.1.G):
 *
 *  1. LOOP_HOME pin — engine defaults `~/.loop`; opensquid pins to
 *     `~/.opensquid` via spawn env so engine reads/writes the right
 *     storage root. Stripping this would make the 38 existing memories
 *     + 10+ existing lessons silently invisible.
 *
 *  2. Stderr drain — engine emits 2 stderr lines (rehydrate stats +
 *     ready message) BEFORE the first JSON-RPC response, and continues
 *     emitting `tracing` lines throughout its lifetime when `RUST_LOG`
 *     is set. The `data`-event listener consumes them; if we omitted
 *     it, the OS pipe buffer (64KB) would fill under RUST_LOG=trace,
 *     engine writes would block, and the JSON-RPC stream would hang.
 *
 *  3. SIGTERM → SIGKILL escalation on `close()` — 2-second grace then
 *     hard kill so opensquid teardown can't be held hostage by an
 *     engine stuck in shutdown.
 *
 *  4. Error wire shape — five engine-custom codes in `-32000..=-32004`
 *     range. RpcError carries `.code` + `.data` so callers can branch
 *     on `PROMOTION_BLOCKED` etc. without string-matching messages.
 *
 *  5. Authored_by wire encoding — INPUT accepts `'user' | 'pack'` (else
 *     maps to engine's `Llm` default); OUTPUT is `'user' | 'pack' |
 *     'agent'` (`Llm` is rendered as `"agent"`). NOT `"llm"`.
 *
 * Types live in `./types.js` — this file owns the transport + class.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

import { resolveEngineBin } from './config.js';
import type {
  CreateMemoryResult,
  GetMemoryResult,
  LessonCaptureFeedbackResult,
  LessonCreateParams,
  LessonCreateResult,
  LessonDiscardResult,
  LessonListResult,
  LessonPromoteResult,
  LessonRecallResult,
  LessonSupersedeResult,
  ManifestAssembleParams,
  ManifestAssembleResult,
  MemoryDeleteResult,
  MemoryListResult,
  MemoryOrigin,
  MemoryScope,
  MemorySearchParams,
  MemorySearchResult,
  MemoryUpdateResult,
  ScopeFilterWire,
  TaskGetLedgerResult,
  TaskLogPhaseResult,
} from './types.js';

/**
 * JSON-RPC error response surfaced as a JS Error subclass. `.code` +
 * `.data` carry the engine-side fields so callers can branch without
 * pattern-matching `.message`.
 */
export class RpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Engine error codes (verified against engine/src/serve.rs:226-258).
 *
 * Standard JSON-RPC range (-32700 / -32600 / -32601 / -32602 / -32603)
 * is mirrored for completeness. Engine-custom codes occupy
 * `-32000..=-32004` and carry a structured `data` payload per T.1.E.
 */
export const ENGINE_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** data: { reasons: string[] } — kebab-case reasons per T.1.E + T.1.F */
  PROMOTION_BLOCKED: -32000,
  /** data: { lesson_id: string } */
  USER_LESSON_IMMUNE: -32001,
  /** data: { id: string } */
  NOT_FOUND: -32002,
  /** data: { memory_id: string, cited_by: number } */
  USER_MEMORY_IMMUNE: -32003,
  /** data: { reason: string } */
  SUPERSEDE_BLOCKED: -32004,
} as const;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Subprocess + JSON-RPC plumbing. One instance ≡ one engine subprocess.
 * Spawns lazily on first `call`; survives crashes (next call respawns).
 */
export class EngineClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private startupAck: Promise<void> | null = null;

  // --- typed wrappers per JSON-RPC method (engine serve.rs:290-310) ---

  async ping(): Promise<{ ok: true; version: string }> {
    return this.call('ping', {});
  }

  async lessonCreate(p: LessonCreateParams): Promise<LessonCreateResult> {
    return this.call('lesson.create', p);
  }

  async lessonRecall(p: { query: string; limit?: number }): Promise<LessonRecallResult> {
    return this.call('lesson.recall', p);
  }

  async lessonPromote(p: { id: string }): Promise<LessonPromoteResult> {
    return this.call('lesson.promote', p);
  }

  async lessonDiscard(p: {
    id: string;
    reason?: string;
    force?: boolean;
  }): Promise<LessonDiscardResult> {
    return this.call('lesson.discard', p);
  }

  async lessonList(p: {
    statuses?: string[];
    limit?: number;
    offset?: number;
  }): Promise<LessonListResult> {
    return this.call('lesson.list', p);
  }

  async lessonCaptureFeedback(p: {
    id: string;
    polarity: 'thumbs_up' | 'thumbs_down';
    source_signal_id?: string;
  }): Promise<LessonCaptureFeedbackResult> {
    return this.call('lesson.capture_feedback', p);
  }

  async lessonSupersede(p: {
    old_id: string;
    new_id: string;
    force?: boolean;
  }): Promise<LessonSupersedeResult> {
    return this.call('lesson.supersede', p);
  }

  async memoryCreate(p: {
    description: string;
    content: string;
    authored_by?: string;
    scope?: MemoryScope;
    origin?: MemoryOrigin;
  }): Promise<CreateMemoryResult> {
    return this.call('memory.create', p);
  }

  async memorySearch(p: MemorySearchParams): Promise<MemorySearchResult> {
    return this.call('memory.search', p);
  }

  async memoryGet(p: { id: string }): Promise<GetMemoryResult> {
    return this.call('memory.get', p);
  }

  async memoryList(p: {
    scope_filter?: ScopeFilterWire;
    limit?: number;
    offset?: number;
  }): Promise<MemoryListResult> {
    return this.call('memory.list', p);
  }

  async memoryUpdate(p: {
    id: string;
    description?: string;
    content?: string;
    scope?: MemoryScope;
  }): Promise<MemoryUpdateResult> {
    return this.call('memory.update', p);
  }

  async memoryDelete(p: { id: string; force?: boolean }): Promise<MemoryDeleteResult> {
    return this.call('memory.delete', p);
  }

  async manifestAssemble(p: ManifestAssembleParams): Promise<ManifestAssembleResult> {
    return this.call('manifest.assemble', p);
  }

  async taskLogPhase(p: {
    task_id: string;
    phase: string;
    note?: string;
  }): Promise<TaskLogPhaseResult> {
    return this.call('task.log_phase', p);
  }

  async taskGetLedger(p: { task_id: string }): Promise<TaskGetLedgerResult> {
    return this.call('task.get_ledger', p);
  }

  // --- transport ------------------------------------------------------

  /**
   * Send a JSON-RPC request, await the response. Throws `RpcError` on
   * engine-side errors; throws `Error` on subprocess crashes.
   *
   * The startup `ping` call passes through without re-entering
   * `ensureStarted` to break the chicken-and-egg.
   */
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (method !== 'ping' || this.proc === null) {
      await this.ensureStarted();
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      if (!this.proc) {
        this.pending.delete(id);
        reject(new Error('engine subprocess not running'));
        return;
      }
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.proc.stdin.write(line);
    });
  }

  /** SIGTERM → 2s → SIGKILL escalation. Resolves once the proc exits. */
  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    proc.kill('SIGTERM');
    return new Promise<void>((resolve) => {
      const escalate = setTimeout(() => proc.kill('SIGKILL'), 2000);
      proc.once('exit', () => {
        clearTimeout(escalate);
        resolve();
      });
    });
  }

  // --- internals ------------------------------------------------------

  private async ensureStarted(): Promise<void> {
    if (this.proc) return;
    if (this.startupAck) return this.startupAck;

    const bin = await resolveEngineBin();
    if (!bin) {
      throw new Error(
        'loop-engine binary not found. Set OPENSQUID_ENGINE_BIN, run ' +
          '`opensquid engine set-path <path>`, or build at ' +
          '~/projects/loop/engine/target/release/loop-engine',
      );
    }

    // CRITICAL: LOOP_HOME pin (T.1.D). Engine defaults to `~/.loop`; we
    // override so its storage root is `~/.opensquid`. Stripping this
    // makes the existing memory + lesson stores silently invisible.
    const proc = spawn(bin, ['serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        LOOP_HOME: process.env.LOOP_HOME ?? `${process.env.HOME ?? ''}/.opensquid`,
      },
    });
    this.proc = proc;
    this.reader = createInterface({ input: proc.stdout });
    this.reader.on('line', (line: string) => this.onLine(line));

    // CRITICAL: drain stderr (T.1.CC). Engine emits 2 stderr lines
    // before first stdout JSON, and continuous tracing lines if
    // RUST_LOG is set. Without this drain, pipe buffer fills and
    // engine blocks.
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) process.stderr.write(`[engine] ${text}\n`);
    });

    proc.on('exit', (code: number | null) => this.onExit(code));
    proc.on('error', (err: Error) => {
      process.stderr.write(`[opensquid] engine spawn error: ${err.message}\n`);
    });

    // Single ping to confirm the engine is live before returning.
    this.startupAck = this.call('ping', {})
      .then(() => undefined)
      .catch((e: Error) => {
        throw new Error(`engine failed to start: ${e.message}`);
      });
    return this.startupAck;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed) as JsonRpcResponse;
    } catch (e) {
      process.stderr.write(`[opensquid] failed to parse engine line: ${String(e)}\n`);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) {
      process.stderr.write(`[opensquid] response for unknown id=${String(msg.id)}\n`);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * #170: clear `startupAck` on exit so the next call's
   * `ensureStarted()` actually respawns instead of returning the stale
   * resolved promise from the previous lifetime. Reject all pending so
   * callers can retry.
   */
  private onExit(code: number | null): void {
    const reason = `loop-engine subprocess exited (code=${code === null ? 'null' : String(code)})`;
    process.stderr.write(`[opensquid] ${reason}\n`);
    this.proc = null;
    this.reader = null;
    this.startupAck = null;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}

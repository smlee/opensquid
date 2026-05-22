/**
 * JSON-RPC 2.0 client for the loop-engine daemon.
 *
 * Connects to a long-running engine process at
 * `~/.opensquid/loop-engine.sock` via Unix domain socket. The daemon
 * is acquired-or-spawned by `acquireOrSpawnEngine()` (singleton.ts),
 * so multiple `EngineClient` instances across hooks + sessions share
 * the same underlying engine process — the keystone for cross-session
 * memory recall.
 *
 * Critical invariants (T.1 audit + T.4 spec):
 *
 *  1. **Singleton transport** — `EngineClient` no longer owns a
 *     subprocess. It holds a `net.Socket` connection to a shared
 *     daemon. Engine lifecycle lives in `singleton.ts`; closing a
 *     client only closes the connection, not the engine.
 *
 *  2. **LOOP_HOME pin** (T.1.D) — handled by `singleton.ts` at spawn
 *     time. Engine defaults `~/.loop`; opensquid pins to
 *     `~/.opensquid`. Stripping the pin would make existing memories
 *     + lessons silently invisible.
 *
 *  3. **Auto-reconnect on socket close** — if the daemon restarts
 *     (kill -9, OOM, manual `engine kill`), the next `call()` will
 *     re-acquire via the singleton. Pending calls reject so callers
 *     can retry.
 *
 *  4. **Error wire shape** — five engine-custom codes in
 *     `-32000..=-32004` range. `RpcError` carries `.code` + `.data`
 *     so callers branch on the structured field, not the message.
 *
 *  5. **Authored_by wire encoding** — INPUT accepts `'user' | 'pack'`
 *     (else maps to engine's `Llm` default); OUTPUT is
 *     `'user' | 'pack' | 'agent'` (`Llm` renders as `"agent"`).
 *
 *  6. **Windows fallback** — UDS is Unix-only. On Windows,
 *     `acquireOrSpawnEngine()` throws; callers wrap with a feature
 *     flag (`OPENSQUID_ENGINE_SOCKET=disable`) to fall back to the
 *     legacy per-process stdio spawn (NOT implemented here yet —
 *     tracked as T.8 follow-up).
 *
 * Types live in `./types.js` — this file owns the transport + class.
 */

import { createInterface, type Interface } from 'node:readline';
import type { Socket } from 'node:net';

import { acquireOrSpawnEngine } from './singleton.js';
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
 * Socket + JSON-RPC plumbing. One instance ≡ one connection to the
 * shared engine daemon. Connection is established lazily on first
 * `call`. Survives daemon restarts: when the socket closes, the next
 * call re-acquires via `acquireOrSpawnEngine()`.
 */
export class EngineClient {
  private socket: Socket | null = null;
  private reader: Interface | null = null;
  private pending = new Map<number, PendingCall>();
  private nextId = 1;
  private startupAck: Promise<void> | null = null;
  private spawnedByUs = false;

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
   * engine-side errors; throws `Error` on socket close mid-call.
   *
   * The startup `ping` call passes through without re-entering
   * `ensureConnected` to break the chicken-and-egg.
   */
  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    if (method !== 'ping' || this.socket === null) {
      await this.ensureConnected();
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      const sock = this.socket;
      if (!sock) {
        this.pending.delete(id);
        reject(new Error('engine connection not established'));
        return;
      }
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      sock.write(line);
    });
  }

  /**
   * Close the connection to the engine daemon. Does NOT kill the
   * daemon — engine lifecycle is owned by `singleton.ts` (and by
   * T.7's `engine kill` for explicit teardown). After close(), the
   * next `call()` will re-acquire.
   */
  async close(): Promise<void> {
    const sock = this.socket;
    if (!sock) return;
    return new Promise<void>((resolve) => {
      // If the socket is already closed, end() is a noop and `close`
      // fires synchronously on the next tick.
      sock.once('close', () => resolve());
      sock.end();
    });
  }

  /**
   * Returns true if this client's last connection was the one that
   * spawned the engine daemon. Useful for telemetry — production
   * callers should not rely on this for correctness.
   */
  get didSpawnEngine(): boolean {
    return this.spawnedByUs;
  }

  // --- internals ------------------------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this.socket) return;
    if (this.startupAck) return this.startupAck;

    // Acquire or spawn. Singleton handles the lock, recheck, spawn,
    // pidfile, and socket-wait — this module just consumes the result.
    const { socket, spawnedByUs } = await acquireOrSpawnEngine();
    this.socket = socket;
    this.spawnedByUs = spawnedByUs;

    // Line-framed JSON-RPC over the socket. `createInterface` strips
    // '\n' and emits per-line events. Same plumbing as the legacy
    // stdio path — only the underlying stream changed.
    this.reader = createInterface({ input: socket });
    this.reader.on('line', (line: string) => {
      this.onLine(line);
    });

    socket.on('close', () => this.onClose('socket closed'));
    socket.on('error', (err: Error) => {
      process.stderr.write(`[opensquid] engine socket error: ${err.message}\n`);
    });

    // Confirm liveness before returning. A successful ping proves the
    // daemon is past rehydrate + ready to dispatch.
    this.startupAck = this.call('ping', {})
      .then(() => undefined)
      .catch((e: Error) => {
        throw new Error(`engine handshake failed: ${e.message}`);
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
   * Clear connection state on close so the next call re-acquires.
   * Mirrors the pre-T.4 behavior for subprocess exits — the daemon
   * may restart out-of-band (kill -9, OOM, T.7 `engine kill`) and
   * the next call should transparently respawn / reconnect.
   */
  private onClose(reason: string): void {
    process.stderr.write(`[opensquid] engine connection closed: ${reason}\n`);
    this.socket = null;
    this.reader = null;
    this.startupAck = null;
    this.spawnedByUs = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`loop-engine connection lost: ${reason}`));
    }
    this.pending.clear();
  }
}

/**
 * chat-bridge subscriber — TPS.6 patch 3 (v0.5.127).
 *
 * Long-lived UDS connection from the MCP-bridge subprocess to the
 * chat-daemon. Subscribes once on startup; thereafter, daemon-side
 * `inbound_message` notifications populate a per-process LRU buffer
 * that the `chat_poll_inbox` tool drains. The filesystem JSONL inbox
 * remains the durable record + the cold-start catch-up path; the
 * buffer is the hot-path cache that avoids per-poll fs reads.
 *
 * Wire shape (per `src.legacy/chat/daemon/protocol.ts`):
 *   → {"jsonrpc":"2.0","id":1,"method":"subscribe","params":{...}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
 *   ← {"jsonrpc":"2.0","method":"inbound_message","params":{...}}  (push, no id)
 *   ← {"jsonrpc":"2.0","method":"daemon_shutdown","params":{...}}  (push)
 *
 * Reconnect: exponential backoff 1s → 60s cap. Triggered on socket
 * 'close' / 'error' / refused-connect. On `daemon_shutdown` we
 * lengthen the first delay to 5s (the daemon is restarting, not just
 * a transient disconnect) to avoid hammering. session_id is stable
 * across reconnects so the daemon can re-attach the slot.
 *
 * Buffer: LRU cap 1000 messages, 24h TTL. Past either bound, entries
 * are silently evicted — `chat_poll_inbox` falls back to fs.readFile
 * for the JSONL replay path.
 *
 * Why a separate module from `chat-bridge-server.ts`: the subscriber
 * has its own lifecycle (connect / reconnect / timer) that's
 * orthogonal to the MCP request/response surface. Keeping it
 * isolated also lets `chat-bridge-server.test.ts` mock the subscriber
 * cleanly via DI.
 *
 * No exported singleton — `main()` in chat-bridge-server.ts owns the
 * single instance and passes it to handlers via closure. Tests
 * construct their own.
 */

import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';

import { LRUCache } from 'lru-cache';

// ---------------------------------------------------------------------------
// Public types — mirror src.legacy/chat/daemon/protocol.ts shapes. We
// re-declare locally rather than import because src.legacy is excluded
// from tsconfig (same type-poison avoidance as the rest of src/mcp/).
// ---------------------------------------------------------------------------

export interface InboundMessage {
  delivery_id: string;
  message_id: string;
  platform: 'telegram' | 'discord' | 'slack';
  channel: string;
  thread_id?: string;
  sender: string;
  sender_id: string;
  text: string;
  received_at: string;
  mentions_bot: boolean;
}

export interface SubscriberOptions {
  socketPath: string;
  sessionId: string;
  workspaceUuid: string;
  workspacePath: string;
  /** Empty = wildcard subscription. */
  chatIds: string[];
  /** Test injection — defaults to LRU 1000/24h. */
  bufferMax?: number;
  bufferTtlMs?: number;
  /** Test injection — defaults to setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  /** Test injection — defaults to (host) net.connect. */
  connectFn?: (path: string) => Socket;
}

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 60_000;
export const SHUTDOWN_BACKOFF_MS = 5000;

// ---------------------------------------------------------------------------
// ChatBridgeSubscriber — the long-lived UDS client.
// ---------------------------------------------------------------------------

export class ChatBridgeSubscriber {
  private socket: Socket | null = null;
  private buf = '';
  private reconnectMs = RECONNECT_BASE_MS;
  private closed = false;
  private subscribeId = 0;
  private readonly buffer: LRUCache<string, InboundMessage>;
  private readonly setTimeoutFn: (cb: () => void, ms: number) => unknown;
  private readonly connectFn: (path: string) => Socket;

  constructor(private readonly opts: SubscriberOptions) {
    this.buffer = new LRUCache<string, InboundMessage>({
      max: opts.bufferMax ?? 1000,
      ttl: opts.bufferTtlMs ?? 1000 * 60 * 60 * 24,
    });
    this.setTimeoutFn = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.connectFn = opts.connectFn ?? ((path) => connect(path));
  }

  /** Open the socket + send subscribe. Subsequent reconnects happen automatically. */
  start(): void {
    this.connectAndSubscribe();
  }

  /** Stop reconnecting + close the socket. Buffer is preserved for late polls. */
  stop(): void {
    this.closed = true;
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }

  /**
   * Return all buffered messages with `enqueued_at` (== received_at)
   * strictly greater than `since` (or every buffered message if
   * since is omitted). Ordering: ascending by received_at. Caller
   * applies a per-call limit.
   */
  drainBuffer(since?: string): InboundMessage[] {
    const out: InboundMessage[] = [];
    for (const msg of this.buffer.values()) {
      if (since && msg.received_at <= since) continue;
      out.push(msg);
    }
    out.sort((a, b) => a.received_at.localeCompare(b.received_at));
    return out;
  }

  /** Diagnostic — current buffer size (test use). */
  bufferSize(): number {
    return this.buffer.size;
  }

  /** Diagnostic — true iff the socket is currently writable. */
  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private connectAndSubscribe(): void {
    if (this.closed) return;
    let sock: Socket;
    try {
      sock = this.connectFn(this.opts.socketPath);
    } catch (err) {
      this.scheduleReconnect(`connect threw: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.socket = sock;
    this.buf = '';
    sock.setEncoding('utf8');
    sock.once('connect', () => this.sendSubscribe());
    sock.on('data', (chunk: string | Buffer) => this.onData(chunk));
    sock.once('error', (err: Error) => {
      process.stderr.write(`[chat-bridge subscriber] socket error: ${err.message}\n`);
    });
    sock.once('close', () => {
      this.socket = null;
      this.scheduleReconnect('socket closed');
    });
  }

  private sendSubscribe(): void {
    if (!this.socket) return;
    const id = `sub-${String(++this.subscribeId)}`;
    const req = {
      jsonrpc: '2.0',
      id,
      method: 'subscribe',
      params: {
        session_id: this.opts.sessionId,
        workspace_uuid: this.opts.workspaceUuid,
        workspace_path: this.opts.workspacePath,
        chat_ids: this.opts.chatIds,
      },
    };
    try {
      this.socket.write(JSON.stringify(req) + '\n');
      // Successful connection — reset backoff.
      this.reconnectMs = RECONNECT_BASE_MS;
    } catch (err) {
      process.stderr.write(
        `[chat-bridge subscriber] subscribe write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  private onData(chunk: string | Buffer): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`[chat-bridge subscriber] malformed JSON: ${line.slice(0, 200)}\n`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as {
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (frame.method === 'inbound_message' && frame.params) {
      const msg = frame.params as InboundMessage;
      if (typeof msg.delivery_id === 'string' && typeof msg.text === 'string') {
        // LRU.set is naturally idempotent on delivery_id — re-pushed
        // notifications during reconnect races overwrite the same slot.
        this.buffer.set(msg.delivery_id, msg);
      }
      return;
    }
    if (frame.method === 'daemon_shutdown') {
      process.stderr.write('[chat-bridge subscriber] daemon shutdown received; backing off\n');
      // Lengthen the next reconnect delay so we don't hammer the
      // restart. The 'close' event that follows will fire
      // scheduleReconnect, which reads this.reconnectMs.
      this.reconnectMs = Math.max(this.reconnectMs, SHUTDOWN_BACKOFF_MS);
      return;
    }
    // Subscribe ack — frame.result.ok === true. Nothing to do; the
    // successful write already reset backoff.
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed) return;
    const delay = this.reconnectMs;
    process.stderr.write(
      `[chat-bridge subscriber] reconnecting in ${String(delay)}ms (${reason})\n`,
    );
    this.setTimeoutFn(() => this.connectAndSubscribe(), delay);
    this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
  }
}

// ---------------------------------------------------------------------------
// Helper — generate a fresh session_id when the host environment doesn't
// provide one. The id is stable per MCP-bridge process so the daemon
// can re-attach on reconnect.
// ---------------------------------------------------------------------------

export function generateSessionId(): string {
  const env = process.env.OPENSQUID_SESSION_ID;
  if (env && env.length > 0) return env;
  return `mcp-${randomUUID()}`;
}

/**
 * subscribers.ts — TPS.6 patch 1 (v0.5.125) subscriber registry.
 *
 * In-process registry of long-lived MCP-bridge subscribers. Each
 * subscriber is an MCP bridge subprocess that opened a UDS connection
 * and called `subscribe` with a session_id + chat_ids selector. The
 * daemon's `gateway.onMessage` handler (wired in TPS.6 patch 2) iterates
 * registry.forChatId(...) and pushes one notification per subscriber.
 *
 * Two indexes:
 *   - byId: session_id → Subscriber (idempotency + unregister)
 *   - byChat: chat_id → Set<session_id> (broadcast lookup)
 *   - wildcardIds: Set<session_id> for subscribers with chat_ids=[]
 *
 * Per-subscriber send queue (bounded, FIFO). When socket.write returns
 * false (kernel buffer full), notifications are queued and drained on
 * the 'drain' event. Queue overflow drops oldest with a logged warning.
 *
 * Lifecycle: register() returns the Subscriber handle; socket close /
 * error events auto-unregister via the listener installed in register().
 * Idempotency: re-register on the same session_id evicts the old slot
 * (with a graceful close of the old socket) before installing the new.
 *
 * No timers; no background work. Purely event-driven from the socket
 * lifecycle + broadcast invocations.
 *
 * Rebuild path: ad-hoc tsc invocation (see telegram.ts header).
 */

import type { Socket } from "node:net";

import type {
  InboundMessageNotification,
  DaemonShutdownNotification,
} from "./protocol.js";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

export interface SubscriberRecord {
  session_id: string;
  workspace_uuid: string;
  workspace_path: string;
  chat_ids: string[];
  /** True iff chat_ids is empty (subscribes to all inbound messages). */
  wildcard: boolean;
  /** Owning socket — closing it auto-unregisters the subscriber. */
  socket: Socket;
  /**
   * Number of notifications dropped due to per-subscriber queue
   * overflow. Surfaced for diagnostics; the daemon never blocks on a
   * slow subscriber.
   */
  dropped_count: number;
}

export const SUBSCRIBER_QUEUE_CAP = 100;

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------

interface InternalEntry {
  record: SubscriberRecord;
  /** FIFO queue of serialized notification lines (already \n-terminated). */
  queue: string[];
  /** Set when socket.write returned false; cleared on 'drain'. */
  paused: boolean;
  /** Installed listeners so we can remove them on unregister. */
  onClose: () => void;
  onError: (err: Error) => void;
  onDrain: () => void;
}

export class SubscriberRegistry {
  private readonly byId = new Map<string, InternalEntry>();
  private readonly byChat = new Map<string, Set<string>>();
  private readonly wildcardIds = new Set<string>();

  /**
   * Install a new subscriber. If `session_id` already exists, the old
   * slot is gracefully closed first (idempotent re-register on
   * MCP-bridge reconnect).
   *
   * Returns the SubscriberRecord. Callers must NOT mutate it.
   */
  register(args: {
    session_id: string;
    workspace_uuid: string;
    workspace_path: string;
    chat_ids: string[];
    socket: Socket;
  }): SubscriberRecord {
    // Evict any existing slot first.
    const existing = this.byId.get(args.session_id);
    if (existing) {
      this.removeFromIndexes(existing.record);
      this.detachListeners(existing);
      try {
        existing.record.socket.end();
      } catch {
        /* socket already closed */
      }
      this.byId.delete(args.session_id);
    }

    const record: SubscriberRecord = {
      session_id: args.session_id,
      workspace_uuid: args.workspace_uuid,
      workspace_path: args.workspace_path,
      chat_ids: [...args.chat_ids],
      wildcard: args.chat_ids.length === 0,
      socket: args.socket,
      dropped_count: 0,
    };

    const entry: InternalEntry = {
      record,
      queue: [],
      paused: false,
      onClose: () => this.unregister(args.session_id),
      onError: () => this.unregister(args.session_id),
      onDrain: () => this.drainQueue(entry),
    };
    args.socket.on("close", entry.onClose);
    args.socket.on("error", entry.onError);
    args.socket.on("drain", entry.onDrain);

    this.byId.set(args.session_id, entry);
    if (record.wildcard) {
      this.wildcardIds.add(args.session_id);
    } else {
      for (const chatId of record.chat_ids) {
        let bucket = this.byChat.get(chatId);
        if (!bucket) {
          bucket = new Set<string>();
          this.byChat.set(chatId, bucket);
        }
        bucket.add(args.session_id);
      }
    }
    return record;
  }

  /**
   * Remove a subscriber (by session_id). Idempotent — no-op if the
   * session is not registered. The socket is NOT closed by unregister
   * (caller decides; auto-unregister-on-close hooks don't want to
   * loop). Returns true iff something was removed.
   */
  unregister(session_id: string): boolean {
    const entry = this.byId.get(session_id);
    if (!entry) return false;
    this.removeFromIndexes(entry.record);
    this.detachListeners(entry);
    this.byId.delete(session_id);
    return true;
  }

  /** All subscribers whose selector matches `chat_id` (literal chat or wildcard). */
  forChatId(chat_id: string): SubscriberRecord[] {
    const matches: SubscriberRecord[] = [];
    const specific = this.byChat.get(chat_id);
    if (specific) {
      for (const id of specific) {
        const entry = this.byId.get(id);
        if (entry) matches.push(entry.record);
      }
    }
    for (const id of this.wildcardIds) {
      const entry = this.byId.get(id);
      if (entry) matches.push(entry.record);
    }
    return matches;
  }

  /** Look up by session_id. */
  get(session_id: string): SubscriberRecord | undefined {
    return this.byId.get(session_id)?.record;
  }

  /** Total registered subscribers (test/diag use). */
  size(): number {
    return this.byId.size;
  }

  /**
   * Push a notification to one subscriber. Returns true if the write
   * went out cleanly, false if it was queued (or dropped on overflow).
   * Never throws — write failures are logged + cause eviction.
   */
  push(session_id: string, notif: InboundMessageNotification | DaemonShutdownNotification): boolean {
    const entry = this.byId.get(session_id);
    if (!entry) return false;
    const line = JSON.stringify(notif) + "\n";
    if (entry.paused) {
      this.enqueue(entry, line);
      return false;
    }
    let ok: boolean;
    try {
      ok = entry.record.socket.write(line);
    } catch {
      // Write to a half-closed socket — evict.
      this.unregister(session_id);
      return false;
    }
    if (!ok) {
      entry.paused = true;
    }
    return ok;
  }

  /**
   * Broadcast a notification to every subscriber matching `chat_id`.
   * Returns the count of attempted deliveries (includes queued ones).
   */
  broadcast(chat_id: string, notif: InboundMessageNotification): number {
    let count = 0;
    for (const subscriber of this.forChatId(chat_id)) {
      this.push(subscriber.session_id, notif);
      count += 1;
    }
    return count;
  }

  /**
   * Send a `daemon_shutdown` notification to every subscriber + close
   * their sockets. Called from worker SIGTERM handler.
   */
  shutdown(reason: string, restartExpectedAt?: string): void {
    const notif: DaemonShutdownNotification = {
      jsonrpc: "2.0",
      method: "daemon_shutdown",
      params: restartExpectedAt
        ? { reason, restart_expected_at: restartExpectedAt }
        : { reason },
    };
    for (const session_id of [...this.byId.keys()]) {
      this.push(session_id, notif);
      const entry = this.byId.get(session_id);
      if (entry) {
        try {
          entry.record.socket.end();
        } catch {
          /* already closed */
        }
      }
    }
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private enqueue(entry: InternalEntry, line: string): void {
    if (entry.queue.length >= SUBSCRIBER_QUEUE_CAP) {
      // Drop oldest, keep newest. Telegram messages are time-sensitive;
      // a backlog of >100 means the subscriber is hopelessly behind
      // and the newest message is more valuable than the oldest.
      entry.queue.shift();
      entry.record.dropped_count += 1;
      process.stderr.write(
        `[subscribers] queue overflow for session=${entry.record.session_id}; dropped oldest (total dropped=${String(entry.record.dropped_count)})\n`,
      );
    }
    entry.queue.push(line);
  }

  private drainQueue(entry: InternalEntry): void {
    while (entry.queue.length > 0) {
      const line = entry.queue[0];
      if (line === undefined) break;
      let ok: boolean;
      try {
        ok = entry.record.socket.write(line);
      } catch {
        this.unregister(entry.record.session_id);
        return;
      }
      entry.queue.shift();
      if (!ok) {
        // Re-paused mid-drain — wait for next 'drain'.
        return;
      }
    }
    entry.paused = false;
  }

  private removeFromIndexes(record: SubscriberRecord): void {
    if (record.wildcard) {
      this.wildcardIds.delete(record.session_id);
    } else {
      for (const chatId of record.chat_ids) {
        const bucket = this.byChat.get(chatId);
        if (!bucket) continue;
        bucket.delete(record.session_id);
        if (bucket.size === 0) this.byChat.delete(chatId);
      }
    }
  }

  private detachListeners(entry: InternalEntry): void {
    try {
      entry.record.socket.off("close", entry.onClose);
      entry.record.socket.off("error", entry.onError);
      entry.record.socket.off("drain", entry.onDrain);
    } catch {
      /* socket already destroyed */
    }
  }
}

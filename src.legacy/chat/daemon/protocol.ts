/**
 * chat-daemon ↔ MCP server wire protocol (v0.7.1 Phase B).
 *
 * Shape: JSON-RPC 2.0 over newline-delimited JSON. One JSON object per
 * line; both directions use the same framing. Stateless — the daemon
 * doesn't track client connections beyond the lifetime of a single
 * request/response pair.
 *
 * Transport address (set by `daemonPaths().sockFile`):
 *   - macOS/Linux: ~/.opensquid/chat-daemon.sock (AF_UNIX)
 *   - Windows:     \\.\pipe\opensquid-chat-daemon (named pipe)
 * Node's `net.createServer({path})` accepts both shapes transparently;
 * `daemonSockAddress()` below returns the right form for the host OS.
 *
 * Why not gRPC / HTTP / MCP-style stdio? gRPC drags in a 3 MB grpc-js
 * dependency that we already explicitly avoided in the engine's
 * subprocess design. HTTP needs port allocation + firewall coordination.
 * MCP stdio needs a parent-child relationship — but the daemon is
 * grandparent / orphan to the MCP servers (it outlives them). Local
 * socket + JSON-RPC is the smallest correct surface.
 */

import * as os from "node:os";
import * as path from "node:path";

import { daemonPaths } from "./lifecycle.js";

// ---------------------------------------------------------------------
// Method catalog
// ---------------------------------------------------------------------

/** Send a chat message via the daemon's owned adapter. */
export interface SendParams {
  channel: string; // e.g. "telegram:8075471258"
  text: string;
  replyTo?: string;
  /** Telegram forum topic id (v0.7.2). Ignored by adapters that don't support threading. */
  threadId?: string;
}

/** v0.7.2 — Create a Telegram forum topic via the daemon's owned bot. */
export interface CreateTopicParams {
  platform: "telegram";
  chat_id: string;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export interface CreateTopicResult {
  message_thread_id: number;
  name: string;
}

export interface SendResult {
  ok: boolean;
  platform: string;
  message_id: string;
  delivered_at: string;
}

/** List the platforms the daemon currently has active adapters for. */
export interface ListChannelsParams {
  /* no params */
}

export interface ListChannelsResult {
  active_platforms: string[];
  uptime_ms: number | null;
  /**
   * 0.7.4 (#147): platforms whose long-poll lost to a 409 Conflict
   * and degraded to outbound-only mode. Surfaced via
   * `chat_daemon_status` so operators can diagnose "where did my
   * inbound message go?"
   */
  outbound_only_platforms?: string[];
}

/** Liveness probe for the auto-spawn path. */
export interface PingParams {
  /* no params */
}

export interface PingResult {
  pong: true;
  pid: number;
  version: string;
}

// ---------------------------------------------------------------------
// TPS.6 (v0.5.125) — subscriber broker primitives
// ---------------------------------------------------------------------

/**
 * Register the calling socket as a long-lived subscriber. Daemon keeps
 * the connection open and pushes `inbound_message` notifications
 * (no `id` field) over the same socket whenever a Telegram message
 * arrives for the listed chat_ids (or any chat_id, when chat_ids is
 * empty — wildcard subscriber).
 *
 * Idempotent on session_id: re-registering with the same session_id
 * evicts the previous slot (and closes its socket) before installing
 * the new one. This lets a reconnecting MCP bridge regain its slot
 * without leaking the old subscriber entry.
 *
 * Returns `bound_topic_id`/`bound_topic_name` when the daemon's
 * auto-boot path (TPS.6 patch 4) resolved-or-created a workspace
 * topic during the handshake. Empty when the workspace already had
 * an explicit binding (idempotent reuse).
 */
export interface SubscribeParams {
  session_id: string;
  workspace_uuid: string;
  workspace_path: string;
  /** Empty array = wildcard (every inbound message). */
  chat_ids: string[];
}

export interface SubscribeResult {
  ok: true;
  bound_topic_id?: number;
  bound_topic_name?: string;
}

export interface UnsubscribeParams {
  session_id: string;
}

export interface UnsubscribeResult {
  ok: true;
}

/**
 * Server-initiated push payload — JSON-RPC 2.0 notification (no `id`
 * field per spec §4.1, so the client MUST NOT reply). One message =
 * one notification frame. `delivery_id` is the idempotency key the
 * client uses to dedupe across reconnects (the daemon may resend a
 * notification if a write-during-disconnect raced with reconnect).
 */
export interface InboundMessageNotification {
  jsonrpc: "2.0";
  method: "inbound_message";
  params: {
    delivery_id: string;
    message_id: string;
    platform: "telegram" | "discord" | "slack";
    channel: string;
    thread_id?: string;
    sender: string;
    sender_id: string;
    text: string;
    received_at: string;
    mentions_bot: boolean;
  };
}

export interface DaemonShutdownNotification {
  jsonrpc: "2.0";
  method: "daemon_shutdown";
  params: {
    reason: string;
    restart_expected_at?: string;
  };
}

export type RpcNotification =
  | InboundMessageNotification
  | DaemonShutdownNotification;

export type DaemonMethod =
  | "send"
  | "list_channels"
  | "ping"
  | "create_topic"
  | "subscribe"
  | "unsubscribe";

// ---------------------------------------------------------------------
// JSON-RPC 2.0 envelopes
// ---------------------------------------------------------------------

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: DaemonMethod;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;

// Standard JSON-RPC error codes (we use the public-rage subset).
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------
// Socket address — cross-platform
// ---------------------------------------------------------------------

/**
 * Return the platform-correct socket address for `net.createServer` /
 * `net.connect`. On Unix this is a path on disk; on Windows this is a
 * named-pipe path. Node accepts both behind the same `{path}` API.
 *
 * On Windows we don't actually have a filesystem path to use, so the
 * pidfile name (without the .pid suffix) drives the pipe name to keep
 * dataRoot isolation working across multiple installs.
 */
export function daemonSockAddress(dataRoot?: string): string {
  const paths = daemonPaths(dataRoot);
  if (os.platform() === "win32") {
    // Windows named pipe — derive a stable name from the data root so
    // tests with tmpdirs and prod with ~/.opensquid don't collide.
    // Pipe names live in a flat namespace; hash the dataRoot to a
    // short suffix.
    const fingerprint = path.basename(path.dirname(paths.sockFile));
    return `\\\\.\\pipe\\opensquid-chat-daemon-${fingerprint}`;
  }
  return paths.sockFile;
}

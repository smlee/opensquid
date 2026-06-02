/**
 * chat-transport daemon ↔ client wire protocol (T-CHAT-AS-TERMINAL CAT.1b).
 *
 * Shape: JSON-RPC 2.0 over newline-delimited JSON. One JSON object per line;
 * both directions use the same framing. Stateless — one request → one response
 * per line, no per-connection session state.
 *
 * Ported faithfully from `src.legacy/chat/daemon/protocol.ts`. The method
 * catalog + result shapes are PRESERVED BYTE-FOR-BYTE because they are consumed
 * live by `src/mcp/chat-bridge-server.ts` and
 * `src/runtime/agent_bridge/tools/chat_send.ts`:
 *
 *   - `send`          params {channel, text, replyTo?, threadId?}
 *                     → result {ok:true, platform, message_id, delivered_at}
 *   - `ping`          → result {pong:true, pid, version}
 *   - `list_channels` → result {active_platforms, uptime_ms, outbound_only_platforms?}
 *   - `create_topic`  params {platform:'telegram', chat_id, name, icon_color?,
 *                              icon_custom_emoji_id?}
 *                     → result {message_thread_id, name}
 *
 * DROPPED vs legacy: `subscribe` / `unsubscribe` / the `inbound_message` push
 * notification. The legacy daemon pushed inbound messages over a long-lived
 * subscriber socket; the new tree's file-tail watcher
 * (`src/runtime/chat/inbound_watch.ts`) replaced that — inbound is delivered by
 * tailing the umbrella inbox JSONL the daemon writes, not by a socket push. So
 * the daemon no longer brokers subscribers; the socket is request/response only.
 *
 * Transport address (`daemonSockAddress()`):
 *   - macOS/Linux: <OPENSQUID_HOME>/chat-daemon.sock (AF_UNIX)
 *   - Windows:     \\.\pipe\opensquid-chat-daemon-<home-fingerprint> (named pipe)
 * Node's `net.createServer({path})` / `net.connect({path})` accept both shapes.
 *
 * Imports from: node:os, node:path, ../../runtime/paths.
 */

import { platform as osPlatform } from 'node:os';
import { basename } from 'node:path';

import { chatDaemonSockPath, OPENSQUID_HOME } from '../../runtime/paths.js';

// ---------------------------------------------------------------------------
// Method params + results
// ---------------------------------------------------------------------------

/** `send` — push an outbound message via the daemon's owned adapter. */
export interface SendParams {
  /** `<platform>:<native_id>` e.g. `telegram:-1001234567890`, or the
   *  composite `telegram:<chat_id>:<thread_id>`. */
  channel: string;
  text: string;
  replyTo?: string;
  /** Telegram forum-topic id; overrides any suffix embedded in `channel`. */
  threadId?: string;
}

export interface SendResult {
  ok: true;
  platform: string;
  message_id: string;
  delivered_at: string;
}

/** `create_topic` — telegram forum-topic creation. */
export interface CreateTopicParams {
  platform: 'telegram';
  chat_id: string;
  name: string;
  icon_color?: number;
  icon_custom_emoji_id?: string;
}

export interface CreateTopicResult {
  message_thread_id: number;
  name: string;
}

/** `list_channels` — which platforms have active adapters. */
export interface ListChannelsResult {
  active_platforms: string[];
  uptime_ms: number | null;
  /** Platforms degraded to outbound-only (409 long-poll collision). */
  outbound_only_platforms?: string[];
}

/** `ping` — liveness probe for the (future, CAT.1d) auto-spawn path. */
export interface PingResult {
  pong: true;
  pid: number;
  version: string;
}

export type DaemonMethod = 'send' | 'list_channels' | 'ping' | 'create_topic';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelopes
// ---------------------------------------------------------------------------

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: DaemonMethod;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;

// Standard JSON-RPC error codes (public subset).
export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Socket address — cross-platform
// ---------------------------------------------------------------------------

/**
 * Return the platform-correct socket address for `net.createServer` /
 * `net.connect`. On Unix this is the on-disk `chat-daemon.sock`; on Windows
 * it's a named pipe whose name is derived from the data-root basename so
 * separate installs (tmpdir tests vs ~/.opensquid prod) don't collide in the
 * flat pipe namespace. Node accepts both behind the same `{path}` API.
 */
export function daemonSockAddress(): string {
  if (osPlatform() === 'win32') {
    const fingerprint = basename(OPENSQUID_HOME());
    return `\\\\.\\pipe\\opensquid-chat-daemon-${fingerprint}`;
  }
  return chatDaemonSockPath();
}

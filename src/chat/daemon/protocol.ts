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

export type DaemonMethod = "send" | "list_channels" | "ping";

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

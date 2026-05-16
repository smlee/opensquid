/**
 * chat-daemon RPC client (v0.7.1 Phase B).
 *
 * Used by the MCP server when it wants to send a chat message but
 * doesn't want to start its own long-poll adapter (which would
 * collide with any other MCP server holding the same bot token).
 *
 * Behavior:
 *   - One short-lived connection per request — keeps the implementation
 *     trivial and avoids reconnect/backoff logic. Performance is fine
 *     for v0.7.1's expected traffic (a handful of agent reports per
 *     project session).
 *   - Returns a typed result on success.
 *   - Throws `DaemonUnreachableError` when the socket can't be reached
 *     so callers can fall back to in-process send.
 *   - Throws `DaemonRpcError` on JSON-RPC error responses.
 */

import { connect, type Socket } from "node:net";

import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ListChannelsResult,
  type PingResult,
  type SendParams,
  type SendResult,
  daemonSockAddress,
} from "./protocol.js";

export class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnreachableError";
  }
}

export class DaemonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

export interface RpcClientOptions {
  dataRoot?: string;
  /** Connect timeout in ms. Default 1500 — local socket, fast. */
  connectTimeoutMs?: number;
  /** Request timeout in ms (waiting for response). Default 5000. */
  requestTimeoutMs?: number;
}

let requestCounter = 0;

export class DaemonClient {
  private readonly address: string;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: RpcClientOptions = {}) {
    this.address = daemonSockAddress(opts.dataRoot);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 1500;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5000;
  }

  ping(): Promise<PingResult> {
    return this.call("ping", {});
  }

  listChannels(): Promise<ListChannelsResult> {
    return this.call("list_channels", {});
  }

  send(params: SendParams): Promise<SendResult> {
    return this.call("send", params);
  }

  async call<R>(method: string, params: unknown): Promise<R> {
    const sock = await this.openSocket();
    try {
      const id = ++requestCounter;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method: method as never, params };
      sock.write(`${JSON.stringify(req)}\n`);
      const line = await readOneLine(sock, this.requestTimeoutMs);
      const res = JSON.parse(line) as JsonRpcResponse<R>;
      if ("error" in res) {
        throw new DaemonRpcError(res.error.message, res.error.code);
      }
      return res.result;
    } finally {
      sock.destroy();
    }
  }

  private openSocket(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const sock = connect({ path: this.address });
      const t = setTimeout(() => {
        sock.destroy();
        reject(new DaemonUnreachableError(`connect timeout (${this.connectTimeoutMs}ms)`));
      }, this.connectTimeoutMs);
      sock.once("connect", () => {
        clearTimeout(t);
        resolve(sock);
      });
      sock.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(t);
        // ENOENT (no socket file) / ECONNREFUSED (no listener) /
        // EACCES (permission) → daemon-unreachable. Other errors
        // propagate as the original error.
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "EACCES") {
          reject(new DaemonUnreachableError(`${err.code}: ${err.message}`));
        } else {
          reject(err);
        }
      });
    });
  }
}

function readOneLine(sock: Socket, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    sock.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        cleanup();
        resolve(buf.slice(0, nl));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onEnd = () => {
      cleanup();
      reject(new DaemonUnreachableError("daemon closed connection without response"));
    };
    const t = setTimeout(() => {
      cleanup();
      reject(new DaemonUnreachableError(`request timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(t);
      sock.off("data", onData);
      sock.off("error", onError);
      sock.off("end", onEnd);
    };
    sock.on("data", onData);
    sock.on("error", onError);
    sock.on("end", onEnd);
  });
}

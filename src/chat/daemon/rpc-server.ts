/**
 * chat-daemon RPC server (v0.7.1 Phase B).
 *
 * Runs INSIDE the daemon worker process. Listens on the platform-
 * correct socket address (Unix socket / named pipe) and dispatches
 * JSON-RPC method calls to the in-process ChatGateway.
 *
 * Connection model: stateless. Each line is one request; each response
 * goes back on the same connection. Connections may pipeline multiple
 * requests, and the server reads line-by-line (we keep a per-connection
 * buffer until \n).
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

import type { ChatGateway } from "../gateway.js";
import {
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  type ListChannelsResult,
  type PingResult,
  type SendParams,
  type SendResult,
  daemonSockAddress,
} from "./protocol.js";

export interface RpcServerOptions {
  gateway: ChatGateway;
  dataRoot?: string;
  startedAt?: number;
  /** Daemon's process version string — surfaced by `ping`. */
  version?: string;
  /** Pid surfaced by `ping`. Defaults to process.pid. */
  pid?: number;
  /** Hook for tests: callback when a request is dispatched. */
  onRequest?: (method: string) => void;
}

export class RpcServer {
  private server: Server;
  private listening = false;
  private readonly address: string;
  private readonly startedAt: number;

  constructor(private readonly opts: RpcServerOptions) {
    this.address = daemonSockAddress(opts.dataRoot);
    this.startedAt = opts.startedAt ?? Date.now();
    this.server = createServer((socket) => this.handleConnection(socket));
    // Treat client errors as informational; a misbehaving client must
    // not crash the daemon.
    this.server.on("error", () => {
      /* swallowed at server level; per-conn errors handled below */
    });
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    // Unix-socket clean-up: a previously-aborted daemon may have left a
    // stale socket file. Removing it is safe because the previous
    // daemon is gone (verified by the lifecycle layer before we got
    // here). Windows named pipes are kernel objects with no file
    // residue, so this is a no-op there.
    if (process.platform !== "win32" && existsSync(this.address)) {
      try {
        unlinkSync(this.address);
      } catch {
        /* race-tolerant */
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.address, () => {
        this.server.off("error", reject);
        this.listening = true;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.listening = false;
    if (process.platform !== "win32" && existsSync(this.address)) {
      try {
        unlinkSync(this.address);
      } catch {
        /* race-tolerant */
      }
    }
  }

  private handleConnection(socket: Socket): void {
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        this.dispatchLine(line, socket);
      }
    });
    socket.on("error", () => {
      // Half-open connections are common; closing here keeps the daemon
      // tidy without surfacing an error to other clients.
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });
  }

  private dispatchLine(line: string, socket: Socket): void {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.respond(socket, parseError());
      return;
    }
    if (!req || req.jsonrpc !== "2.0" || typeof req.id === "undefined" || !req.method) {
      this.respond(socket, invalidRequest((req as JsonRpcRequest | undefined)?.id ?? null));
      return;
    }
    if (this.opts.onRequest) this.opts.onRequest(req.method);
    void this.handle(req).then((res) => this.respond(socket, res));
  }

  private respond(socket: Socket, response: JsonRpcSuccess | JsonRpcFailure): void {
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      /* dropped — connection gone */
    }
  }

  private async handle(req: JsonRpcRequest): Promise<JsonRpcSuccess | JsonRpcFailure> {
    try {
      switch (req.method) {
        case "ping":
          return success<PingResult>(req.id, {
            pong: true,
            pid: this.opts.pid ?? process.pid,
            version: this.opts.version ?? "unknown",
          });
        case "list_channels":
          return success<ListChannelsResult>(req.id, {
            active_platforms: this.opts.gateway.activePlatforms(),
            uptime_ms: Date.now() - this.startedAt,
          });
        case "send": {
          const p = req.params as SendParams | undefined;
          if (!p || typeof p.channel !== "string" || typeof p.text !== "string") {
            return failure(req.id, JSON_RPC_INVALID_PARAMS, "send: channel + text required");
          }
          const result = await this.opts.gateway.send({
            channel: p.channel,
            text: p.text,
            replyTo: p.replyTo,
          });
          return success<SendResult>(req.id, {
            ok: true,
            platform: result.platform,
            message_id: result.messageId,
            delivered_at: result.deliveredAt.toISOString(),
          });
        }
        default:
          return failure(req.id, JSON_RPC_METHOD_NOT_FOUND, `unknown method: ${req.method}`);
      }
    } catch (err) {
      return failure(
        req.id,
        JSON_RPC_INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ---------------------------------------------------------------------
// JSON-RPC response helpers
// ---------------------------------------------------------------------

function success<R>(id: number | string, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: number | string | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseError(): JsonRpcFailure {
  return failure(null, JSON_RPC_PARSE_ERROR, "parse error");
}

function invalidRequest(id: number | string | null): JsonRpcFailure {
  return failure(id, JSON_RPC_INVALID_REQUEST, "invalid jsonrpc request");
}

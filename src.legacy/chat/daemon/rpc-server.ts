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
  type CreateTopicParams,
  type CreateTopicResult,
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
  type SubscribeParams,
  type SubscribeResult,
  type UnsubscribeParams,
  type UnsubscribeResult,
  daemonSockAddress,
} from "./protocol.js";
import { SubscriberRegistry } from "./subscribers.js";

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
  /**
   * TPS.6 patch 1 (v0.5.125) — long-lived subscriber registry. The
   * gateway.onMessage wire-up that broadcasts to this registry lands
   * in patch 2 (v0.5.126). For patch 1, the daemon accepts
   * subscribe/unsubscribe RPCs but does not yet push notifications.
   */
  readonly subscribers = new SubscriberRegistry();

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
      // tidy without surfacing an error to other clients. Subscriber
      // eviction is handled by the registry's own socket 'error'/'close'
      // listeners installed at register() time, so we don't need to
      // touch the registry here.
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
    void this.handle(req, socket).then((res) => this.respond(socket, res));
  }

  private respond(socket: Socket, response: JsonRpcSuccess | JsonRpcFailure): void {
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } catch {
      /* dropped — connection gone */
    }
  }

  private async handle(req: JsonRpcRequest, socket: Socket): Promise<JsonRpcSuccess | JsonRpcFailure> {
    try {
      switch (req.method) {
        case "subscribe": {
          const p = req.params as SubscribeParams | undefined;
          if (
            !p ||
            typeof p.session_id !== "string" ||
            p.session_id.length === 0 ||
            typeof p.workspace_uuid !== "string" ||
            typeof p.workspace_path !== "string" ||
            !Array.isArray(p.chat_ids)
          ) {
            return failure(
              req.id,
              JSON_RPC_INVALID_PARAMS,
              "subscribe: session_id, workspace_uuid, workspace_path, chat_ids[] required",
            );
          }
          for (const id of p.chat_ids) {
            if (typeof id !== "string") {
              return failure(req.id, JSON_RPC_INVALID_PARAMS, "subscribe: chat_ids[] must be strings");
            }
          }
          this.subscribers.register({
            session_id: p.session_id,
            workspace_uuid: p.workspace_uuid,
            workspace_path: p.workspace_path,
            chat_ids: p.chat_ids,
            socket,
          });
          // Auto-boot (bound_topic_id/_name) lands in TPS.6 patch 4
          // (v0.5.128). For patch 1 we just acknowledge registration.
          return success<SubscribeResult>(req.id, { ok: true });
        }
        case "unsubscribe": {
          const p = req.params as UnsubscribeParams | undefined;
          if (!p || typeof p.session_id !== "string" || p.session_id.length === 0) {
            return failure(req.id, JSON_RPC_INVALID_PARAMS, "unsubscribe: session_id required");
          }
          this.subscribers.unregister(p.session_id);
          return success<UnsubscribeResult>(req.id, { ok: true });
        }
        case "ping":
          return success<PingResult>(req.id, {
            pong: true,
            pid: this.opts.pid ?? process.pid,
            version: this.opts.version ?? "unknown",
          });
        case "list_channels": {
          // 0.7.4 (#147): walk active adapters and ask which are
          // outbound-only (degraded due to 409 collision with an
          // external poller). Only the telegram adapter currently
          // exposes isOutboundOnly(); duck-type test so other
          // platforms can opt in later without changing this code.
          const platforms = this.opts.gateway.activePlatforms();
          const outboundOnly: string[] = [];
          for (const p of platforms) {
            const adapter = this.opts.gateway.getAdapter(p);
            const maybe = adapter as unknown as { isOutboundOnly?: () => boolean };
            if (typeof maybe?.isOutboundOnly === "function" && maybe.isOutboundOnly()) {
              outboundOnly.push(p);
            }
          }
          return success<ListChannelsResult>(req.id, {
            active_platforms: platforms,
            uptime_ms: Date.now() - this.startedAt,
            outbound_only_platforms: outboundOnly,
          });
        }
        case "send": {
          const p = req.params as SendParams | undefined;
          if (!p || typeof p.channel !== "string" || typeof p.text !== "string") {
            return failure(req.id, JSON_RPC_INVALID_PARAMS, "send: channel + text required");
          }
          const result = await this.opts.gateway.send({
            channel: p.channel,
            text: p.text,
            replyTo: p.replyTo,
            threadId: p.threadId,
          });
          return success<SendResult>(req.id, {
            ok: true,
            platform: result.platform,
            message_id: result.messageId,
            delivered_at: result.deliveredAt.toISOString(),
          });
        }
        case "create_topic": {
          const p = req.params as CreateTopicParams | undefined;
          if (
            !p ||
            p.platform !== "telegram" ||
            typeof p.chat_id !== "string" ||
            typeof p.name !== "string"
          ) {
            return failure(
              req.id,
              JSON_RPC_INVALID_PARAMS,
              "create_topic: platform='telegram', chat_id, name required",
            );
          }
          const adapter = this.opts.gateway.getAdapter(p.platform);
          if (
            !adapter ||
            typeof (adapter as { createTopic?: unknown }).createTopic !== "function"
          ) {
            return failure(
              req.id,
              JSON_RPC_INTERNAL_ERROR,
              `${p.platform} adapter does not support topic creation (or not active)`,
            );
          }
          const adapterAny = adapter as unknown as {
            createTopic: (
              chatId: string,
              name: string,
              opts: { iconColor?: number; iconCustomEmojiId?: string },
            ) => Promise<{ message_thread_id: number; name: string }>;
          };
          const res = await adapterAny.createTopic(p.chat_id, p.name, {
            iconColor: p.icon_color,
            iconCustomEmojiId: p.icon_custom_emoji_id,
          });
          return success<CreateTopicResult>(req.id, res);
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

/**
 * chat-transport daemon RPC server (T-CHAT-AS-TERMINAL CAT.1b).
 *
 * Runs INSIDE the daemon worker. Listens on the platform-correct socket
 * address (Unix socket / named pipe) and dispatches JSON-RPC method calls to
 * the in-process `ChatGateway`. Ported from `src.legacy/chat/daemon/
 * rpc-server.ts`, minus the dropped subscribe/unsubscribe broker (see
 * `./protocol.ts` — the file-tail watcher replaced inbound push).
 *
 * Connection model: stateless. Each newline-delimited line is one request; the
 * response goes back on the same connection. Connections may pipeline; the
 * server buffers per-connection until `\n`.
 *
 * The `send` result shape `{ok:true, platform, message_id, delivered_at}` and
 * the method names are LOAD-BEARING — `src/mcp/chat-bridge-server.ts` +
 * `src/runtime/agent_bridge/tools/chat_send.ts` parse them. Do not change them.
 *
 * Imports from: node:net, node:fs, ../gateway, ./protocol.
 * Imported by: ./worker.ts + tests.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

import type { ChatGateway } from '../gateway.js';

import {
  daemonSockAddress,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  type CreateTopicParams,
  type CreateTopicResult,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type ListChannelsResult,
  type PingResult,
  type SendParams,
  type SendResult,
} from './protocol.js';

export interface RpcServerOptions {
  gateway: ChatGateway;
  startedAt?: number;
  /** Daemon process version string — surfaced by `ping`. */
  version?: string;
  /** Pid surfaced by `ping`. Defaults to process.pid. */
  pid?: number;
  /** Hook for tests: fires when a request is dispatched. */
  onRequest?: (method: string) => void;
}

export class RpcServer {
  private readonly server: Server;
  private listening = false;
  private readonly address: string;
  private readonly startedAt: number;

  constructor(private readonly opts: RpcServerOptions) {
    this.address = daemonSockAddress();
    this.startedAt = opts.startedAt ?? Date.now();
    this.server = createServer((socket) => this.handleConnection(socket));
    // A misbehaving client must not crash the daemon. Per-connection errors
    // are handled in handleConnection.
    this.server.on('error', () => {
      /* swallowed at server level */
    });
  }

  /** The resolved socket address (for diagnostics / tests). */
  get socketAddress(): string {
    return this.address;
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    // Clean up a stale Unix socket left by an aborted daemon. Safe: the
    // lifecycle layer verified no live daemon before we got here. Windows
    // named pipes leave no file residue, so this is a no-op there.
    if (process.platform !== 'win32' && existsSync(this.address)) {
      try {
        unlinkSync(this.address);
      } catch {
        /* race-tolerant */
      }
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.address, () => {
        this.server.off('error', onError);
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
    if (process.platform !== 'win32' && existsSync(this.address)) {
      try {
        unlinkSync(this.address);
      } catch {
        /* race-tolerant */
      }
    }
  }

  private handleConnection(socket: Socket): void {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        this.dispatchLine(line, socket);
      }
    });
    socket.on('error', () => {
      // Half-open connections are common; close quietly without surfacing.
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
    if (
      req === null ||
      typeof req !== 'object' ||
      req.jsonrpc !== '2.0' ||
      typeof req.id === 'undefined' ||
      typeof req.method !== 'string'
    ) {
      const maybeId = (req as JsonRpcRequest | undefined)?.id;
      this.respond(socket, invalidRequest(maybeId ?? null));
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
        case 'ping':
          return success<PingResult>(req.id, {
            pong: true,
            pid: this.opts.pid ?? process.pid,
            version: this.opts.version ?? 'unknown',
          });

        case 'list_channels': {
          const platforms = this.opts.gateway.activePlatforms();
          // Duck-type isOutboundOnly so a platform can opt in later without
          // changing this code. The new telegram adapter does not expose it
          // yet, so this stays empty for now.
          const outboundOnly: string[] = [];
          for (const p of platforms) {
            const adapter = this.opts.gateway.getAdapter(p);
            const maybe = adapter as unknown as { isOutboundOnly?: () => boolean };
            if (typeof maybe.isOutboundOnly === 'function' && maybe.isOutboundOnly()) {
              outboundOnly.push(p);
            }
          }
          return success<ListChannelsResult>(req.id, {
            active_platforms: platforms,
            uptime_ms: Date.now() - this.startedAt,
            outbound_only_platforms: outboundOnly,
          });
        }

        case 'send': {
          const p = req.params as SendParams | undefined;
          if (
            p === undefined ||
            typeof p.channel !== 'string' ||
            typeof p.text !== 'string'
          ) {
            return failure(req.id, JSON_RPC_INVALID_PARAMS, 'send: channel + text required');
          }
          const result = await this.opts.gateway.send({
            channel: p.channel,
            text: p.text,
            ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}),
            ...(p.threadId !== undefined ? { threadId: p.threadId } : {}),
            // CAT.4 — additive media path (text → caption when present).
            ...(p.mediaPath !== undefined ? { mediaPath: p.mediaPath } : {}),
          });
          return success<SendResult>(req.id, {
            ok: true,
            platform: result.platform,
            message_id: result.messageId,
            delivered_at: result.deliveredAt.toISOString(),
          });
        }

        case 'create_topic': {
          const p = req.params as CreateTopicParams | undefined;
          if (
            p?.platform !== 'telegram' ||
            typeof p.chat_id !== 'string' ||
            typeof p.name !== 'string'
          ) {
            return failure(
              req.id,
              JSON_RPC_INVALID_PARAMS,
              "create_topic: platform='telegram', chat_id, name required",
            );
          }
          const res = await this.opts.gateway.createTopic({
            platform: 'telegram',
            chatId: p.chat_id,
            name: p.name,
            ...(p.icon_color !== undefined ? { iconColor: p.icon_color } : {}),
            ...(p.icon_custom_emoji_id !== undefined
              ? { iconCustomEmojiId: p.icon_custom_emoji_id }
              : {}),
          });
          return success<CreateTopicResult>(req.id, res);
        }

        default:
          return failure(req.id, JSON_RPC_METHOD_NOT_FOUND, `unknown method: ${String(req.method)}`);
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

// ---------------------------------------------------------------------------
// JSON-RPC response helpers
// ---------------------------------------------------------------------------

function success<R>(id: number | string, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: number | string | null, code: number, message: string): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function parseError(): JsonRpcFailure {
  return failure(null, JSON_RPC_PARSE_ERROR, 'parse error');
}

function invalidRequest(id: number | string | null): JsonRpcFailure {
  return failure(id, JSON_RPC_INVALID_REQUEST, 'invalid jsonrpc request');
}

/**
 * The single owner of the chat-daemon client (T-CHAT-FINALIZE-REMOVE-LEGACY CL.1).
 *
 * Before this module the one-shot JSON-RPC-over-UNIX-socket dance was copy-pasted into
 * ~5 call sites (agent_bridge/tools/chat_send, mcp/chat-bridge-server, setup/cli/
 * chat_actions_test_step, functions/ensure_umbrella_topic) plus the socket-path
 * derivation in ~5 places — duplication that existed only because `src.legacy/` is
 * tsconfig-excluded so `src/` couldn't import the legacy `DaemonClient`. This is that
 * shared client (the home the chat_send.ts:15-22 comment named). STRICT extraction: the
 * socket/timeout/decode behavior matches the prior `defaultDaemonSend` byte-for-byte;
 * `daemonRpc` just generalizes it over the RPC `method` + result type.
 *
 * Scope (Simplicity — no method without a present caller): socket-path resolution, one
 * one-shot `daemonRpc`, and the typed `sendChat` wrapper. No pooling / retry / streaming —
 * the daemon calls are one-shot, so a one-shot client is the correct shape.
 *
 * Imports from: node:net, node:os, ../runtime/paths.js.
 * Imported by: the chat-daemon call sites (CL.3).
 */

import { connect, type Socket } from 'node:net';
import { platform as osPlatform } from 'node:os';

import { chatDaemonSockPath, OPENSQUID_HOME } from '../runtime/paths.js';

/**
 * The chat-daemon socket address. Unix: the canonical `chatDaemonSockPath()`
 * (`<home>/chat-daemon.sock`). Win32: a named pipe whose fingerprint = the last path
 * segment of the data root (keeps multiple installs isolated — the convention the legacy
 * `daemonSockAddress` used). This is the ONE place the Win32 branch lives now.
 */
export function daemonSocketPath(): string {
  if (osPlatform() === 'win32') {
    const fingerprint = OPENSQUID_HOME().split(/[\\/]/).pop() ?? 'default';
    return `\\\\.\\pipe\\opensquid-chat-daemon-${fingerprint}`;
  }
  return chatDaemonSockPath();
}

/** The `send` RPC result (the narrow slice the callers use). */
export interface DaemonSendResult {
  ok: boolean;
  platform: string;
  message_id: string;
  delivered_at: string;
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

let rpcCounter = 0;

/**
 * One-shot JSON-RPC over the daemon UNIX socket: connect → write a single newline-framed
 * request → read the first newline-framed response → resolve its `result` (or reject on
 * RPC error / malformed JSON / connection error / timeout). Never spawns the daemon — a
 * down daemon surfaces as a connection-error rejection.
 */
export function daemonRpc<T>(
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise<T>((resolveCall, rejectCall) => {
    const id = `opensquid-client-${++rpcCounter}-${Date.now()}`;
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    let sock: Socket | null = null;
    let buffer = '';
    const cleanup = (): void => {
      if (sock !== null) {
        try {
          sock.end();
        } catch {
          /* socket already closed */
        }
        sock = null;
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectCall(new Error(`chat-daemon RPC timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    sock = connect(daemonSocketPath());
    sock.once('error', (err: Error) => {
      clearTimeout(timer);
      cleanup();
      rejectCall(new Error(`chat-daemon connection error: ${err.message}`));
    });
    sock.once('connect', () => sock?.write(req));
    sock.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      clearTimeout(timer);
      cleanup();
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse<T>;
        if (parsed.error) {
          rejectCall(
            new Error(`chat-daemon RPC error ${parsed.error.code}: ${parsed.error.message}`),
          );
        } else if (parsed.result !== undefined) {
          resolveCall(parsed.result);
        } else {
          rejectCall(new Error('chat-daemon RPC: malformed response (no result or error)'));
        }
      } catch (e) {
        rejectCall(
          new Error(
            `chat-daemon RPC: invalid JSON response: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    });
  });
}

/** Parameters for the daemon `send` RPC (the daemon's media field is `mediaPath`). */
export interface DaemonSendParams {
  channel: string;
  text: string;
  replyTo?: string;
  threadId?: string;
  /** Absolute path to a local image delivered as a photo (text → caption). */
  imagePath?: string;
}

/** Typed `send` RPC — the one-shot reply path used by the agent-bridge + MCP bridge. */
export const sendChat = (params: DaemonSendParams): Promise<DaemonSendResult> =>
  daemonRpc<DaemonSendResult>('send', {
    channel: params.channel,
    text: params.text,
    ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    ...(params.imagePath !== undefined ? { mediaPath: params.imagePath } : {}),
  });

/** Typed `create_topic` RPC — creates one Telegram forum topic, returns its thread id. */
export const createTopic = (
  chatId: string,
  name: string,
): Promise<{ message_thread_id: number; name: string }> =>
  daemonRpc<{ message_thread_id: number; name: string }>('create_topic', {
    platform: 'telegram',
    chat_id: chatId,
    name,
  });

/** Liveness gate — true iff a chat-daemon answers `ping` on its socket. Any failure ⇒ false. */
export const pingDaemon = async (timeoutMs = 1500): Promise<boolean> => {
  try {
    const r = await daemonRpc<{ pong?: boolean }>('ping', {}, { timeoutMs });
    return r.pong === true;
  } catch {
    return false;
  }
};

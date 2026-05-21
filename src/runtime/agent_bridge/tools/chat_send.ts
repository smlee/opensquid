/**
 * agent_bridge built-in tool — `chat_send`.
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` WAB.6 §"Tool
 * surface". Wraps the chat-daemon's `send` JSON-RPC method so the warm
 * agent can reply on the same channel that delivered the inbound message.
 *
 * Responsibility:
 *   1. Build a `project:<platform>` shorthand from the session's platform if
 *      the model didn't supply an explicit `channel` arg — the most common
 *      path is "reply on the same Telegram topic that delivered me".
 *   2. Forward the request to the chat-daemon over its UNIX socket via the
 *      same one-shot JSON-RPC pattern used by `src/mcp/chat-bridge-server.ts`
 *      and the legacy `DaemonClient`. We re-implement the socket dance here
 *      (rather than importing) because:
 *        - `src.legacy/` is excluded from `tsconfig.build.json` — production
 *          builds can't depend on it.
 *        - `chat-bridge-server.ts` is an MCP-shaped binary, not a reusable
 *          library. Pulling its handlers into the agent-bridge would couple
 *          tool wiring to MCP transport boundaries.
 *      The duplicated socket logic is small (~40 LOC) and will collapse onto
 *      a shared `src/chat_daemon/client.ts` in a later cleanup pass.
 *
 * Non-responsibility:
 *   - Does NOT spawn the daemon. If the daemon isn't running, the call
 *     fails — the error surfaces back to the model as the tool_result so it
 *     can decide whether to retry or surrender.
 *   - Does NOT validate the channel URI scheme; the daemon does that.
 *
 * Imports from: node:net, node:os, node:path, ../types.js, ../../paths.js,
 *   zod.
 * Imported by: ./index.ts (tools barrel).
 */

import { connect, type Socket } from 'node:net';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import type { ToolContext, ToolHandler, ToolSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Daemon socket address — mirrors `src.legacy/chat/daemon/protocol.ts`
// `daemonSockAddress` so production wiring lands on the same socket the
// chat-daemon listens on. OPENSQUID_HOME override honored for tests.
// ---------------------------------------------------------------------------

function daemonSocketPath(): string {
  const root = process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid');
  if (osPlatform() === 'win32') {
    // Windows named pipe — last path segment of the data root drives the
    // pipe name to keep multiple installs isolated (same convention as
    // the legacy `daemonSockAddress`).
    const fingerprint = root.split(/[\\/]/).pop() ?? 'default';
    return `\\\\.\\pipe\\opensquid-chat-daemon-${fingerprint}`;
  }
  return join(root, 'chat-daemon.sock');
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope types — narrow slice of what `send` returns.
// ---------------------------------------------------------------------------

interface DaemonSendResult {
  ok: boolean;
  platform: string;
  message_id: string;
  delivered_at: string;
}

interface JsonRpcResponse {
  result?: DaemonSendResult;
  error?: { code: number; message: string };
}

let rpcCounter = 0;

// ---------------------------------------------------------------------------
// Public seam — the daemon socket call. Exposed so the sibling test can
// stub it without going through process-level network mocks.
// ---------------------------------------------------------------------------

export interface DaemonSendParams {
  channel: string;
  text: string;
  replyTo?: string;
  threadId?: string;
}

export type DaemonSendFn = (params: DaemonSendParams) => Promise<DaemonSendResult>;

/** Default daemon-send implementation — one-shot UDS RPC. */
export const defaultDaemonSend: DaemonSendFn = (params) => {
  return new Promise<DaemonSendResult>((resolveCall, rejectCall) => {
    const id = `agent-bridge-${++rpcCounter}-${Date.now()}`;
    const req =
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'send',
        params: {
          channel: params.channel,
          text: params.text,
          ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
          ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
        },
      }) + '\n';

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
      rejectCall(new Error('chat-daemon RPC timeout after 5s'));
    }, 5000);

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
        const parsed = JSON.parse(line) as JsonRpcResponse;
        if (parsed.error) {
          rejectCall(
            new Error(`chat-daemon RPC error ${parsed.error.code}: ${parsed.error.message}`),
          );
        } else if (parsed.result) {
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
};

// ---------------------------------------------------------------------------
// Tool input schema + spec
//
// `text` is required (no point in an empty reply). `channel` defaults to
// `project:<platform>` derived from the session key at handler-time — so
// the model gets the most common path right with zero args. Explicit
// `channel` overrides for callers that need to cross-post.
// ---------------------------------------------------------------------------

const ChatSendInput = z.object({
  text: z.string().min(1),
  channel: z.string().min(1).optional(),
});
type ChatSendInputT = z.infer<typeof ChatSendInput>;

export const chatSendSpec: ToolSpec = {
  name: 'chat_send',
  description:
    'Send a reply to the user on the active chat channel. Defaults to the channel that delivered the inbound message.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Reply body (plain text).' },
      channel: {
        type: 'string',
        description:
          'Optional channel override. Defaults to "project:<platform>" derived from the inbound session.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  validate: (input) => ChatSendInput.parse(input),
};

// ---------------------------------------------------------------------------
// Handler factory — closes over the daemon-send seam so tests can inject
// a stub without monkey-patching node:net.
// ---------------------------------------------------------------------------

export function makeChatSendHandler(daemonSend: DaemonSendFn = defaultDaemonSend): ToolHandler {
  return async (input, ctx: ToolContext) => {
    const parsed = input as ChatSendInputT; // already narrowed by validate
    const channel = parsed.channel ?? `project:${ctx.sessionKey.platform}`;
    const params: DaemonSendParams = {
      channel,
      text: parsed.text,
      ...(ctx.sessionKey.threadId !== undefined ? { threadId: ctx.sessionKey.threadId } : {}),
    };
    const result = await daemonSend(params);
    return `sent ok (platform=${result.platform}, message_id=${result.message_id})`;
  };
}

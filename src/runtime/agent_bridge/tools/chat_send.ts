/**
 * agent_bridge built-in tool — `chat_send`.
 *
 * Authoritative spec: the warm-agent planning notes [not retained — see docs/tasks/WAB.1-architecture.md, which is] WAB.6 §"Tool
 * surface". Wraps the chat-daemon's `send` JSON-RPC method so the warm
 * agent can reply on the same channel that delivered the inbound message.
 *
 * Responsibility:
 *   1. Build a `project:<platform>` shorthand from the session's platform if
 *      the model didn't supply an explicit `channel` arg — the most common
 *      path is "reply on the same Telegram topic that delivered me".
 *   2. Forward the request to the chat-daemon over its UNIX socket via the
 *      same one-shot JSON-RPC pattern used by `src/mcp/chat-bridge-server.ts`
 *      and `src/chat_daemon/client.ts`. We re-implement the socket dance here
 *      (rather than importing) because:
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

import { z } from 'zod';

import { sendChat } from '../../../chat_daemon/client.js';
import type { ToolContext, ToolHandler, ToolSpec } from '../types.js';

// ---------------------------------------------------------------------------
// JSON-RPC envelope types — narrow slice of what `send` returns.
// ---------------------------------------------------------------------------

interface DaemonSendResult {
  ok: boolean;
  platform: string;
  message_id: string;
  delivered_at: string;
}

// ---------------------------------------------------------------------------
// Public seam — the daemon socket call. Exposed so the sibling test can
// stub it without going through process-level network mocks.
// ---------------------------------------------------------------------------

export interface DaemonSendParams {
  channel: string;
  text: string;
  replyTo?: string;
  threadId?: string;
  /** CAT.4 — absolute path to a local image to deliver as a photo (text →
   *  caption). Forwarded to the daemon `send` RPC as `mediaPath`. */
  imagePath?: string;
}

export type DaemonSendFn = (params: DaemonSendParams) => Promise<DaemonSendResult>;

/** Default daemon-send — the shared client's one-shot UDS RPC (CL.3: was a local copy
 *  of the socket dance; now delegates to the one owner src/chat_daemon/client.ts). The
 *  local `DaemonSendParams`/`DaemonSendResult` are structurally identical to the client's. */
export const defaultDaemonSend: DaemonSendFn = (params) => sendChat(params);

// ---------------------------------------------------------------------------
// Tool input schema + spec
//
// `text` is required (no point in an empty reply). `channel` defaults to
// `project:<platform>` derived from the session key at handler-time — so
// the model gets the most common path right with zero args. Explicit
// `channel` overrides for callers that need to cross-post.
// ---------------------------------------------------------------------------

const ChatSendInput = z
  .object({
    text: z.string(),
    channel: z.string().min(1).optional(),
    /** CAT.4 — optional absolute path to a local image to attach. When set,
     *  `text` becomes the photo caption and may be empty. */
    imagePath: z.string().min(1).optional(),
  })
  // A reply must carry SOMETHING: either non-empty text or an image. (Was
  // `text.min(1)`; relaxed so image-only sends are valid, with caption empty.)
  .refine((v) => v.text.length > 0 || v.imagePath !== undefined, {
    message: 'chat_send requires non-empty text or an imagePath',
  });
type ChatSendInputT = z.infer<typeof ChatSendInput>;

export const chatSendSpec: ToolSpec = {
  name: 'chat_send',
  description:
    'Send a reply to the user on the active chat channel. Defaults to the channel that delivered the inbound message.',
  input_schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Reply body (plain text). Becomes the caption when imagePath is set.',
      },
      channel: {
        type: 'string',
        description:
          'Optional channel override. Defaults to "project:<platform>" derived from the inbound session.',
      },
      imagePath: {
        type: 'string',
        description:
          'Optional absolute path to a local image to send as a photo. When set, text is the caption and may be empty.',
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
      ...(parsed.imagePath !== undefined ? { imagePath: parsed.imagePath } : {}),
    };
    const result = await daemonSend(params);
    return `sent ok (platform=${result.platform}, message_id=${result.message_id})`;
  };
}

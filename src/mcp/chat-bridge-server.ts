#!/usr/bin/env node
/**
 * `opensquid-chat-bridge-mcp` — MCP server bridging Claude Code sessions
 * to the running chat-daemon's UMBRELLA Telegram routing.
 *
 * Why this is a SEPARATE MCP server from `opensquid-mcp`:
 *   `src/mcp/server.ts` is intentionally read-only by design (per its
 *   own header comment: "Mutations live behind hook bindings + rule
 *   processes; the MCP surface is read-only inspection so an external
 *   client can never bypass the dispatcher"). The chat bridge needs
 *   ONE mutation tool — `chat_send` — to be useful. Adding it to the
 *   read-only server would violate the dispatcher-bypass guard for the
 *   whole opensquid surface. Putting it in its own MCP binary keeps
 *   the guard intact: opensquid-mcp stays read-only; this server is
 *   the explicit + bounded exception.
 *
 * Tools (2):
 *   - `chat_poll_inbox` — read-only. Returns inbound messages from the
 *     active UMBRELLA's `~/.opensquid/umbrellas/<id>/inbox/<platform>.jsonl`
 *     since an optional `since` ISO-8601 timestamp. Caller tracks the
 *     cursor; server is stateless. Honors per-platform filter.
 *
 *   - `chat_send` — explicit mutation. Connects to the chat-daemon's
 *     UDS RPC server at `~/.opensquid/chat-daemon.sock` and calls its
 *     `send` JSON-RPC method. Accepts the `project:<platform>` shorthand
 *     that resolves to the active umbrella's outbound Telegram target via
 *     `channels.json`. Daemon must already be running (this server does
 *     NOT spawn it).
 *
 * Active-umbrella resolution (T-CHAT-AS-TERMINAL CAT.1c): resolve the cwd
 * (`CLAUDE_PROJECT_DIR` env, else `process.cwd()`) to its umbrella via
 * `loadChannelsConfig()` + `resolveUmbrellaForCwd` (longest-prefix over
 * `members`). `channels.json` is synthesized at the CAT.1d cutover, so an
 * absent config / unresolved umbrella is treated as "no inbox" (empty,
 * fail-quiet), never an error.
 *
 * Transport: stdio. stdout reserved for MCP JSON-RPC; diagnostics to
 * stderr only. NO `console.log` in this binary or its imports.
 *
 * Imports from: @modelcontextprotocol/sdk + zod + zod-to-json-schema.
 * Imported by: nothing in src/. Wired as the `opensquid-chat-bridge-mcp`
 * bin in package.json.
 */

import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { ensureChatDaemonRunning } from '../channels/daemon/autospawn.js';
import {
  GENERAL_UMBRELLA,
  loadChannelsConfig,
  resolveOutbound,
  resolveUmbrellaForCwd,
} from '../channels/routing.js';
import { type InboxRow } from '../runtime/chat/inbox.js';

import { daemonSocketPath } from '../chat_daemon/client.js';

import { anchorProcessToProjectDir } from './anchor.js';
import { ChatBridgeSubscriber, generateSessionId } from './chat_bridge_subscriber.js';

// ---------------------------------------------------------------------------
// Data-root (inbox dir). `daemonSocketPath` is now the shared client's (CL.3):
// the local copy honored LOOP_HOME + used a fingerprint-less Win32 pipe, both of
// which DIVERGED from where the daemon actually listens (OPENSQUID_HOME + the
// `basename(OPENSQUID_HOME)` fingerprint, per channels/daemon/protocol.ts) — i.e.
// latent bugs. The client matches the daemon exactly.
// ---------------------------------------------------------------------------

function resolveDataRoot(): string {
  return process.env.OPENSQUID_HOME ?? process.env.LOOP_HOME ?? join(homedir(), '.opensquid');
}

function umbrellaInboxDir(umbrellaId: string): string {
  return join(resolveDataRoot(), 'umbrellas', umbrellaId, 'inbox');
}

/**
 * Resolve the active umbrella from the session's cwd. Prefers
 * `CLAUDE_PROJECT_DIR` (the dir Claude Code launched in) over `process.cwd()`
 * (the MCP server's own cwd, which may differ). Absent channels.json or an
 * unresolved cwd → null (no umbrella bound; the caller treats it as no inbox).
 */
async function resolveActiveUmbrella(): Promise<string | null> {
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const cfg = await loadChannelsConfig();
  if (cfg === null) return null;
  return resolveUmbrellaForCwd(cfg, cwd);
}

// ---------------------------------------------------------------------------
// chat_poll_inbox — filesystem read of the umbrella inbox JSONL.
// ---------------------------------------------------------------------------

// LL.1 (2026-05-30) — `InboxMessage` inline shape lifted to the canonical
// `InboxRow` Zod schema in `src/runtime/chat/inbox.ts` so the MCP tool, the
// LL.3 chokidar tail watcher, and the LL.4 UPS hook all bind to one parser.
// Local alias kept so the rest of this file's call sites stay readable.
type InboxMessage = InboxRow;

// ---------------------------------------------------------------------------
// TPS.6 patch 3 — buffer/fs merge helpers.
// ---------------------------------------------------------------------------

function mergeSubscriberBuffer(
  sub: ChatBridgeSubscriber,
  platform?: 'telegram' | 'discord' | 'slack',
): InboxMessage[] {
  const raw = sub.drainBuffer();
  const out: InboxMessage[] = [];
  for (const m of raw) {
    if (platform && m.platform !== platform) continue;
    const converted: InboxMessage = {
      v: 1,
      id: m.message_id,
      ...(m.thread_id !== undefined ? { thread_id: m.thread_id } : {}),
      platform: m.platform,
      channel: m.channel,
      sender: m.sender,
      sender_id: m.sender_id,
      text: m.text,
      // Subscriber gives received_at (platform-stamped); use it as
      // enqueued_at for the merge. The slight clock skew vs the fs
      // file's appendToInbox stamp is acceptable — both fields are
      // monotonic-per-source and the merge sort is stable.
      received_at: m.received_at,
      enqueued_at: m.received_at,
      mentions_bot: m.mentions_bot,
    };
    out.push(converted);
  }
  return out;
}

function mergeAndSortInboxMessages(
  fsMessages: InboxMessage[],
  bufferMessages: InboxMessage[],
): InboxMessage[] {
  // De-dupe by message_id; buffer wins on collision (newer source).
  const byId = new Map<string, InboxMessage>();
  for (const m of fsMessages) byId.set(m.id, m);
  for (const m of bufferMessages) byId.set(m.id, m);
  const merged = [...byId.values()];
  merged.sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
  return merged;
}

async function pollInbox(opts: {
  umbrellaId: string;
  platform?: 'telegram' | 'discord' | 'slack';
  limit: number;
  since?: string;
}): Promise<{ messages: InboxMessage[]; scanned_platforms: string[] }> {
  const dir = umbrellaInboxDir(opts.umbrellaId);
  const platforms: ('telegram' | 'discord' | 'slack')[] = opts.platform
    ? [opts.platform]
    : ['telegram', 'discord', 'slack'];
  const all: InboxMessage[] = [];
  const scanned: string[] = [];
  for (const p of platforms) {
    const file = join(dir, `${p}.jsonl`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      scanned.push(p);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          all.push(JSON.parse(line) as InboxMessage);
        } catch {
          /* skip malformed line */
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const filtered = opts.since ? all.filter((m) => m.enqueued_at > opts.since!) : all;
  filtered.sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
  return { messages: filtered.slice(-opts.limit), scanned_platforms: scanned };
}

// ---------------------------------------------------------------------------
// chat_send — UDS JSON-RPC call to chat-daemon's `send` method. One-shot
// connection per call (matches legacy DaemonClient pattern).
// ---------------------------------------------------------------------------

interface DaemonSendResult {
  ok: boolean;
  platform: string;
  message_id: string;
  delivered_at: string;
}

class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

let rpcCounter = 0;

// ---------------------------------------------------------------------------
// TPS.6 patch 3 (v0.5.127) — long-lived subscriber. Created in main();
// chat_poll_inbox handler drains its LRU buffer first, then falls back
// to the fs JSONL inbox for cold-start catch-up. Module-level mutable
// so the closure in ToolHandlers can read it without restructuring.
// ---------------------------------------------------------------------------

let activeSubscriber: ChatBridgeSubscriber | null = null;

async function daemonSend(params: {
  channel: string;
  text: string;
  replyTo?: string;
  threadId?: string;
}): Promise<DaemonSendResult> {
  return new Promise((resolveCall, rejectCall) => {
    const id = `mcp-${++rpcCounter}-${Date.now()}`;
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
      if (sock) {
        try {
          sock.end();
        } catch {
          /* socket already closed */
        }
        sock = null;
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectCall(new DaemonUnreachableError(`chat-daemon RPC timeout after 5s`));
    }, 5000);

    try {
      sock = connect(daemonSocketPath());
    } catch (err) {
      clearTimeout(timeout);
      rejectCall(
        new DaemonUnreachableError(
          `failed to connect to chat-daemon at ${daemonSocketPath()}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      return;
    }
    sock.once('error', (err: Error) => {
      clearTimeout(timeout);
      cleanup();
      rejectCall(new DaemonUnreachableError(`chat-daemon connection error: ${err.message}`));
    });
    sock.once('connect', () => {
      sock?.write(req);
    });
    sock.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      clearTimeout(timeout);
      cleanup();
      try {
        const parsed = JSON.parse(line) as {
          result?: DaemonSendResult;
          error?: { code: number; message: string };
        };
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
}

// ---------------------------------------------------------------------------
// `project:<platform>` shorthand resolution (CAT.1c). Resolves the active
// umbrella's outbound Telegram target from `channels.json` (REPLACING the
// per-project chat-routing.json read). The `project:` prefix is kept as the
// stable agent-facing shorthand — it now means "this session's umbrella".
// Only telegram has a structured outbound target in channels.json today;
// discord/slack have no umbrella-level binding yet → null (caller errors).
// ---------------------------------------------------------------------------

async function resolveProjectChannel(
  platform: 'telegram' | 'discord' | 'slack',
): Promise<{ channel: string; threadId?: string } | null> {
  if (platform !== 'telegram') return null;
  const cfg = await loadChannelsConfig();
  if (cfg === null) return null;
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const umbrella = resolveUmbrellaForCwd(cfg, cwd) ?? GENERAL_UMBRELLA;
  const tg = resolveOutbound(cfg, umbrella);
  if (tg === null) return null;
  // The daemon's `send` RPC / gateway parseChannel require the
  // `<platform>:<native_id>` wire form — bare `chat_id` has no colon and is
  // rejected as malformed. Prefix the platform.
  const channel = `telegram:${tg.chat_id}`;
  const threadId = tg.topic_id !== undefined ? String(tg.topic_id) : undefined;
  return threadId === undefined ? { channel } : { channel, threadId };
}

// ---------------------------------------------------------------------------
// MCP tool definitions.
// ---------------------------------------------------------------------------

const PollInboxSchema = z.object({
  since: z
    .string()
    .optional()
    .describe(
      'ISO-8601 timestamp. Only messages with `enqueued_at` greater than this are returned. Caller tracks the cursor between calls.',
    ),
  platform: z
    .enum(['telegram', 'discord', 'slack'])
    .optional()
    .describe('Restrict to one platform. Default: scan all platforms.'),
  limit: z.number().int().min(1).max(50).default(20),
});

const SendSchema = z.object({
  channel: z
    .string()
    .min(1)
    .describe(
      "Outbound channel. One of: (a) `<platform>:<native_id>` literal (e.g. `telegram:-1001234567890`); (b) Telegram forum-topic composite `telegram:<chat_id>:<thread_id>` (e.g. `telegram:-1001234567890:15`) — same shape echoed by `chat_poll_inbox`, can be passed back verbatim; (c) `project:<platform>` magic shorthand that resolves to the active project's report_channel + report_topic_id.",
    ),
  text: z.string().min(1),
  reply_to: z
    .string()
    .optional()
    .describe('Source message id to thread under (best-effort per platform).'),
  thread_id: z
    .string()
    .optional()
    .describe(
      'Explicit thread / topic id. Overrides any thread suffix embedded in `channel`. Telegram only (forum-topic message_thread_id). Ignored on platforms without sub-thread routing.',
    ),
});

const ToolHandlers = {
  chat_poll_inbox: {
    schema: PollInboxSchema,
    handle: async (args: z.infer<typeof PollInboxSchema>): Promise<string> => {
      const umbrellaId = await resolveActiveUmbrella();
      if (umbrellaId === null) {
        return 'No active umbrella — cwd has no umbrella in ~/.opensquid/channels.json. Add a matching `members` prefix or `cd` into a member directory.';
      }
      const arg: {
        umbrellaId: string;
        limit: number;
        platform?: 'telegram' | 'discord' | 'slack';
        since?: string;
      } = {
        umbrellaId,
        limit: args.limit,
      };
      if (args.platform) arg.platform = args.platform;
      if (args.since) arg.since = args.since;
      // TPS.6 patch 3 (v0.5.127): merge subscriber's push-fed LRU
      // buffer with the fs JSONL inbox. Buffer carries low-latency
      // hot messages (~ms from arrival); fs carries cold-start
      // catch-up + messages older than the buffer TTL/LRU eviction.
      // De-dupe by message_id (the platform-native id is stable
      // across both sources). Filter by `since` AFTER merge; apply
      // limit as the last step.
      const { messages: fsMessages, scanned_platforms } = await pollInbox(arg);
      const bufferMessages = activeSubscriber
        ? mergeSubscriberBuffer(activeSubscriber, args.platform)
        : [];
      const merged = mergeAndSortInboxMessages(fsMessages, bufferMessages);
      const filtered = args.since ? merged.filter((m) => m.enqueued_at > args.since!) : merged;
      const limited = filtered.slice(-args.limit);
      if (limited.length === 0) {
        return `No new messages in umbrella ${umbrellaId} (scanned: ${scanned_platforms.join(', ') || '<none>'}).`;
      }
      const cursor = limited[limited.length - 1]?.enqueued_at ?? '';
      const lines = limited.map(
        (m) =>
          `[${m.enqueued_at}] ${m.platform}/${m.channel}${m.thread_id ? ':' + m.thread_id : ''} <${m.sender}> ${m.text}`,
      );
      return `${lines.join('\n')}\n\n--\nUmbrella: ${umbrellaId}\nScanned: ${scanned_platforms.join(', ')}\nReturned: ${limited.length}\nNext cursor (pass as 'since'): ${cursor}`;
    },
  },
  chat_send: {
    schema: SendSchema,
    handle: async (args: z.infer<typeof SendSchema>): Promise<string> => {
      let channel = args.channel.trim();
      // Precedence: explicit args.thread_id > project:<platform> resolved
      // thread > thread suffix embedded in channel. The daemon adapter
      // honours the same precedence when it parses the channel itself,
      // but we resolve the project: shorthand HERE so we can pass a
      // clean (channel, threadId) tuple downstream.
      let threadId: string | undefined = args.thread_id;
      if (channel.startsWith('project:')) {
        const platformRaw = channel.slice('project:'.length);
        if (platformRaw !== 'telegram' && platformRaw !== 'discord' && platformRaw !== 'slack') {
          throw new Error(`unknown project shorthand: project:${platformRaw}`);
        }
        const platformName: 'telegram' | 'discord' | 'slack' = platformRaw;
        const umbrellaId = await resolveActiveUmbrella();
        if (umbrellaId === null) {
          throw new Error(
            'cannot resolve project:<platform> — no active umbrella (cwd has no umbrella in channels.json)',
          );
        }
        const resolved = await resolveProjectChannel(platformName);
        if (!resolved) {
          throw new Error(
            `active umbrella ${umbrellaId} has no ${platformName} outbound target in channels.json`,
          );
        }
        channel = resolved.channel;
        if (threadId === undefined && resolved.threadId) threadId = resolved.threadId;
      }
      const sendArgs: { channel: string; text: string; replyTo?: string; threadId?: string } = {
        channel,
        text: args.text,
      };
      if (args.reply_to) sendArgs.replyTo = args.reply_to;
      if (threadId) sendArgs.threadId = threadId;
      const result = await daemonSend(sendArgs);
      return `sent to ${channel}${threadId ? ' (thread ' + threadId + ')' : ''} — message_id=${result.message_id} at ${result.delivered_at}`;
    },
  },
} as const;

type ToolName = keyof typeof ToolHandlers;

// T-MCP-TOOL-ANNOTATIONS: honest MCP behavior hints (see server.ts for the
// full rationale). chat_send is OPEN-WORLD — it messages external Telegram —
// so annotation-aware hosts keep prompting on it; the inbox poll is read-only.
const toolAnnotations: Record<ToolName, ToolAnnotations> = {
  chat_poll_inbox: { readOnlyHint: true, openWorldHint: false },
  chat_send: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

const descriptions: Record<ToolName, string> = {
  chat_poll_inbox:
    "Read inbound messages for the active umbrella's chat inbox (resolved from cwd via ~/.opensquid/channels.json). Returns messages with `enqueued_at` greater than the optional `since` ISO-8601 cursor. Caller tracks the cursor between calls; server is stateless.",
  chat_send:
    "Send a text message via the chat-daemon's owned bot. Supports `<platform>:<native_id>` literal channels OR the `project:<platform>` magic shorthand that resolves to the active umbrella's outbound Telegram target (chat + forum topic) from channels.json. Requires the chat-daemon to be running.",
};

// ---------------------------------------------------------------------------
// MCP server bootstrap.
// ---------------------------------------------------------------------------

/**
 * Read the published package version at runtime. Same pattern as
 * `src/mcp/server.ts` (T.1.H fix) — the prior hardcoded `'0.5.92'`
 * here had drifted ~25 patch bumps behind reality. Resolve
 * `package.json` relative to this module's URL so the lookup works in
 * both `dist/mcp/chat-bridge-server.js` (built) and
 * `src/mcp/chat-bridge-server.ts` (vitest) layouts.
 */
function readPackageVersion(): string {
  try {
    const pkgJsonPath = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  anchorProcessToProjectDir();
  const server = new Server(
    { name: 'opensquid-chat-bridge', version: readPackageVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: (Object.keys(ToolHandlers) as ToolName[]).map((name) => ({
        name,
        description: descriptions[name],
        annotations: toolAnnotations[name],
        inputSchema: zodToJsonSchema(ToolHandlers[name].schema) as {
          type: 'object';
          [k: string]: unknown;
        },
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name as ToolName;
    const handler = ToolHandlers[name];
    if (!handler) throw new Error(`Unknown tool: ${String(req.params.name)}`);
    const parsed = handler.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid args for ${name}: ${parsed.error.message}`);
    }
    const text = await (handler.handle as (a: unknown) => Promise<string>)(parsed.data);
    return { content: [{ type: 'text' as const, text }] };
  });

  // TPS.6 patch 3 (v0.5.127): boot the long-lived UDS subscriber.
  // Wildcard subscription (chat_ids=[]) — the MCP bridge handles
  // per-workspace filtering itself via the active UMBRELLA resolved
  // on each chat_poll_inbox call. workspace_uuid / workspace_path are
  // reported to the daemon for diagnostics and for the auto-boot path
  // (TPS.6 patch 4). If the cwd resolves to no umbrella at startup, the
  // bridge is running outside any umbrella — subscribe anyway with a
  // sentinel so the daemon still pushes broadcasts (the buffer remains
  // useful even without an umbrella identity).
  const startupUmbrella = (await resolveActiveUmbrella()) ?? 'no-umbrella';
  activeSubscriber = new ChatBridgeSubscriber({
    socketPath: daemonSocketPath(),
    sessionId: generateSessionId(),
    workspaceUuid: startupUmbrella,
    workspacePath: process.cwd(),
    chatIds: [],
  });
  activeSubscriber.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // CAT.1d — opportunistically ensure the NEW chat-transport daemon is running
  // so `chat_send` has a socket to dial + inbound Telegram lands in the umbrella
  // inboxes. Fire-and-forget (never block the stdio loop); no-op when no chat
  // platform is configured or a daemon is already up. Replaces the autospawn
  // that fired from the retired legacy MCP server.
  void (async () => {
    const res = await ensureChatDaemonRunning();
    if (res.status === 'spawned' || res.status === 'waited_for_peer') {
      process.stderr.write(
        `[opensquid] chat-daemon ${res.status === 'spawned' ? 'started' : 'found peer'} (pid ${String(res.pid)})\n`,
      );
    } else if (res.status === 'error') {
      process.stderr.write(`[opensquid] chat-daemon autospawn error: ${String(res.error)}\n`);
    }
    // already_running / no_config → silent
  })();
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid-chat-bridge-mcp crash: ${String(e)}\n`);
  process.exit(1);
});

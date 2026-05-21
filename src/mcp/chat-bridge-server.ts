#!/usr/bin/env node
/**
 * `opensquid-chat-bridge-mcp` — MCP server bridging Claude Code sessions
 * to the running chat-daemon's per-project Telegram routing.
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
 *     active project's `~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl`
 *     since an optional `since` ISO-8601 timestamp. Caller tracks the
 *     cursor; server is stateless. Honors per-platform filter.
 *
 *   - `chat_send` — explicit mutation. Connects to the chat-daemon's
 *     UDS RPC server at `~/.opensquid/chat-daemon.sock` and calls its
 *     `send` JSON-RPC method. Accepts the `project:<platform>` shorthand
 *     that resolves to the active project's `report_channel` +
 *     `report_topic_id` from `chat-routing.json`. Daemon must already
 *     be running (this server does NOT spawn it).
 *
 * Active-project resolution: walk up from `process.cwd()` looking for
 * `.opensquid/project.json` (legacy convention). Falls back to
 * `OPENSQUID_PROJECT_UUID` env override.
 *
 * Transport: stdio. stdout reserved for MCP JSON-RPC; diagnostics to
 * stderr only. NO `console.log` in this binary or its imports.
 *
 * Imports from: @modelcontextprotocol/sdk + zod + zod-to-json-schema.
 * Imported by: nothing in src/. Wired as the `opensquid-chat-bridge-mcp`
 * bin in package.json.
 */

import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { connect, type Socket } from 'node:net';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ---------------------------------------------------------------------------
// Data-root + daemon-socket resolution. Mirrors legacy paths exactly so
// this bridge connects to the same daemon the rest of opensquid spawned.
// OPENSQUID_HOME + LOOP_HOME overrides honored.
// ---------------------------------------------------------------------------

function resolveDataRoot(): string {
  return process.env.OPENSQUID_HOME ?? process.env.LOOP_HOME ?? join(homedir(), '.opensquid');
}

function daemonSocketPath(): string {
  if (platform() === 'win32') {
    return `\\\\.\\pipe\\opensquid-chat-daemon`;
  }
  return join(resolveDataRoot(), 'chat-daemon.sock');
}

function projectInboxDir(projectUuid: string): string {
  return join(resolveDataRoot(), 'projects', projectUuid, 'inbox');
}

function projectChatRoutingPath(projectUuid: string): string {
  return join(resolveDataRoot(), 'projects', projectUuid, 'chat-routing.json');
}

// ---------------------------------------------------------------------------
// Active-project detection: walk up from cwd looking for
// .opensquid/project.json. Same convention as legacy findProjectCard.
// ---------------------------------------------------------------------------

interface ProjectCard {
  version: 1;
  id: string;
  uuid: string;
}

async function resolveActiveProjectUuid(): Promise<string | null> {
  if (process.env.OPENSQUID_PROJECT_UUID) return process.env.OPENSQUID_PROJECT_UUID;
  let dir = resolve(process.cwd());
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, '.opensquid', 'project.json');
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed = JSON.parse(raw) as ProjectCard;
      if (parsed?.version === 1 && parsed.uuid && parsed.id) {
        return parsed.uuid;
      }
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// chat_poll_inbox — filesystem read of project inbox JSONL.
// ---------------------------------------------------------------------------

interface InboxMessage {
  v: 1;
  id: string;
  thread_id?: string;
  platform: 'telegram' | 'discord' | 'slack';
  channel: string;
  sender: string;
  sender_id: string;
  text: string;
  received_at: string;
  enqueued_at: string;
  mentions_bot: boolean;
}

async function pollInbox(opts: {
  projectUuid: string;
  platform?: 'telegram' | 'discord' | 'slack';
  limit: number;
  since?: string;
}): Promise<{ messages: InboxMessage[]; scanned_platforms: string[] }> {
  const dir = projectInboxDir(opts.projectUuid);
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
// `project:<platform>` shorthand resolution. Reads the active project's
// chat-routing.json and returns the resolved channel + thread_id.
// ---------------------------------------------------------------------------

interface TelegramRouting {
  report_channel?: string;
  report_topic_id?: number;
}
interface ProjectChatRouting {
  telegram?: TelegramRouting;
  discord?: { report_channel?: string };
  slack?: { report_channel?: string };
}

async function resolveProjectChannel(
  projectUuid: string,
  platform: 'telegram' | 'discord' | 'slack',
): Promise<{ channel: string; threadId?: string } | null> {
  try {
    const raw = await fs.readFile(projectChatRoutingPath(projectUuid), 'utf8');
    const cfg = JSON.parse(raw) as ProjectChatRouting;
    if (platform === 'telegram') {
      const channel = cfg.telegram?.report_channel;
      if (!channel) return null;
      const threadId =
        cfg.telegram?.report_topic_id !== undefined
          ? String(cfg.telegram.report_topic_id)
          : undefined;
      return threadId === undefined ? { channel } : { channel, threadId };
    }
    if (platform === 'discord' && cfg.discord?.report_channel) {
      return { channel: cfg.discord.report_channel };
    }
    if (platform === 'slack' && cfg.slack?.report_channel) {
      return { channel: cfg.slack.report_channel };
    }
    return null;
  } catch {
    return null;
  }
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
      "Outbound channel. Either `<platform>:<native_id>` literal (e.g. `telegram:-1001234567890`) or the magic `project:<platform>` shorthand that resolves to the active project's report_channel + report_topic_id.",
    ),
  text: z.string().min(1),
  reply_to: z
    .string()
    .optional()
    .describe('Source message id to thread under (best-effort per platform).'),
});

const ToolHandlers = {
  chat_poll_inbox: {
    schema: PollInboxSchema,
    handle: async (args: z.infer<typeof PollInboxSchema>): Promise<string> => {
      const uuid = await resolveActiveProjectUuid();
      if (!uuid) {
        return 'No active project — cwd has no .opensquid/project.json. Set OPENSQUID_PROJECT_UUID or `cd` into a project directory.';
      }
      const arg: {
        projectUuid: string;
        limit: number;
        platform?: 'telegram' | 'discord' | 'slack';
        since?: string;
      } = {
        projectUuid: uuid,
        limit: args.limit,
      };
      if (args.platform) arg.platform = args.platform;
      if (args.since) arg.since = args.since;
      const { messages, scanned_platforms } = await pollInbox(arg);
      if (messages.length === 0) {
        return `No new messages in project ${uuid} (scanned: ${scanned_platforms.join(', ') || '<none>'}).`;
      }
      const cursor = messages[messages.length - 1]?.enqueued_at ?? '';
      const lines = messages.map(
        (m) =>
          `[${m.enqueued_at}] ${m.platform}/${m.channel}${m.thread_id ? ':' + m.thread_id : ''} <${m.sender}> ${m.text}`,
      );
      return `${lines.join('\n')}\n\n--\nProject: ${uuid}\nScanned: ${scanned_platforms.join(', ')}\nReturned: ${messages.length}\nNext cursor (pass as 'since'): ${cursor}`;
    },
  },
  chat_send: {
    schema: SendSchema,
    handle: async (args: z.infer<typeof SendSchema>): Promise<string> => {
      let channel = args.channel.trim();
      let threadId: string | undefined;
      if (channel.startsWith('project:')) {
        const platformRaw = channel.slice('project:'.length);
        if (platformRaw !== 'telegram' && platformRaw !== 'discord' && platformRaw !== 'slack') {
          throw new Error(`unknown project shorthand: project:${platformRaw}`);
        }
        const platformName: 'telegram' | 'discord' | 'slack' = platformRaw;
        const uuid = await resolveActiveProjectUuid();
        if (!uuid) {
          throw new Error(
            'cannot resolve project:<platform> — no active project (cwd has no .opensquid/project.json)',
          );
        }
        const resolved = await resolveProjectChannel(uuid, platformName);
        if (!resolved) {
          throw new Error(
            `active project ${uuid} has no ${platformName} report_channel in chat-routing.json`,
          );
        }
        channel = resolved.channel;
        if (resolved.threadId) threadId = resolved.threadId;
      }
      const sendArgs: { channel: string; text: string; replyTo?: string; threadId?: string } = {
        channel,
        text: args.text,
      };
      if (args.reply_to) sendArgs.replyTo = args.reply_to;
      if (threadId) sendArgs.threadId = threadId;
      const result = await daemonSend(sendArgs);
      return `sent to ${result.platform}:${channel}${threadId ? ' (thread ' + threadId + ')' : ''} — message_id=${result.message_id} at ${result.delivered_at}`;
    },
  },
} as const;

type ToolName = keyof typeof ToolHandlers;

const descriptions: Record<ToolName, string> = {
  chat_poll_inbox:
    "Read inbound messages for the active project's chat inbox (resolved from cwd's .opensquid/project.json or OPENSQUID_PROJECT_UUID env). Returns messages with `enqueued_at` greater than the optional `since` ISO-8601 cursor. Caller tracks the cursor between calls; server is stateless.",
  chat_send:
    "Send a text message via the chat-daemon's owned bot. Supports `<platform>:<native_id>` literal channels OR the `project:<platform>` magic shorthand that resolves to the active project's report_channel + report_topic_id (Telegram forum topic). Requires the chat-daemon to be running.",
};

// ---------------------------------------------------------------------------
// MCP server bootstrap.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = new Server(
    { name: 'opensquid-chat-bridge', version: '0.5.92' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: (Object.keys(ToolHandlers) as ToolName[]).map((name) => ({
        name,
        description: descriptions[name],
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e: unknown) => {
  process.stderr.write(`opensquid-chat-bridge-mcp crash: ${String(e)}\n`);
  process.exit(1);
});

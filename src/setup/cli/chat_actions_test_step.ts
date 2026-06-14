/**
 * WIZ.4 — channel-test step for the chat-setup wizard.
 *
 * Extracted from `chat_actions.ts` to keep the orchestrator under the
 * 450-LOC file-size cap. Single public entry point: `runChannelTestStep`.
 *
 * Behavior:
 *   - Honors `OPENSQUID_NO_BILLED_CALLS=1` — when set, the offer is
 *     skipped entirely (no confirm prompt, no RPC call). The Telegram
 *     Bot API call isn't an LLM call, but the WIZ.4 spec lumps it under
 *     the same skip flag so CI / `pnpm test` never makes external calls.
 *   - Opt-in via `confirm({ initialValue: false })` — default decline.
 *   - On accept: resolves project UUID via the same chain the chat-bridge
 *     MCP uses (env override → cwd .opensquid/project.json walk).
 *   - Detects the chat-daemon liveness from the WIZ.2 snapshot; if not
 *     running, prints the start-hint and returns without dialing.
 *   - Resolves `project:telegram` → real channel via the on-disk
 *     `~/.opensquid/projects/<uuid>/chat-routing.json` shape. We inline
 *     the read (not import a shared helper) because it is a trivial
 *     read-and-parse and keeps WIZ.4 self-contained — same approach
 *     `test/e2e/telegram-multi-project-routing.test.ts` uses. Threads
 *     `report_topic_id` through as `threadId` so the test lands in the
 *     right forum topic.
 *   - Dials the chat-daemon over its Unix socket with a one-shot
 *     JSON-RPC call (same pattern `src/mcp/chat-bridge-server.ts`
 *     uses for chat_send — keeps WIZ.4 self-contained).
 *   - On success: pretty-prints message_id in green.
 *   - On failure: classifies the error (daemon unreachable / routing
 *     missing / bot token invalid / generic) and prints a specific
 *     recovery hint per WIZ.4 spec.
 *
 * Never throws past the wizard — failures print and return so the wizard
 * still hits its success outro. The write has already happened by the
 * time this step runs (post-write per WIZ.4 spec).
 *
 * Imports from: @clack/prompts, picocolors, node:fs/promises, node:net,
 *   node:path, ../../runtime/paths.
 * Imported by: src/setup/cli/chat_actions.ts.
 */

import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';

import { confirm, isCancel, note, spinner } from '@clack/prompts';
import pc from 'picocolors';

import { OPENSQUID_HOME, resolveProjectUuid } from '../../runtime/paths.js';

import type { ChatDaemonState } from './chat_state.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ChannelTestDeps {
  /** WIZ.2 daemon snapshot. Avoids re-dialing the pidfile + sock probe. */
  daemonState: ChatDaemonState;
  /** Override for cwd-walk start (test injection). Defaults to process.cwd(). */
  cwd?: string;
  /** Env-var override sink (test injection). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override the send function (test injection). Defaults to the real
   *  Unix-socket JSON-RPC client. Tests substitute a fake here. */
  send?: (params: SendTestParams) => Promise<SendTestResult>;
  /** Override the routing-read function (test injection). Defaults to
   *  reading `~/.opensquid/projects/<uuid>/chat-routing.json`. */
  loadRouting?: (uuid: string) => Promise<ProjectChatRouting | null>;
}

const TEST_CHANNEL = 'project:telegram';
const TEST_TEXT = 'Chat setup wizard test — config working.';

// ---------------------------------------------------------------------------
// runChannelTestStep — the WIZ.4 entry point. Returns void; never throws.
// ---------------------------------------------------------------------------

export async function runChannelTestStep(deps: ChannelTestDeps): Promise<void> {
  const env = deps.env ?? process.env;
  if (env.OPENSQUID_NO_BILLED_CALLS === '1') {
    note('Test skipped (OPENSQUID_NO_BILLED_CALLS=1).', 'Test');
    return;
  }

  const doTest = await confirm({
    message: 'Test channel delivery via chat-daemon now? (sends one message to your Telegram)',
    initialValue: false,
  });
  if (isCancel(doTest) || doTest !== true) {
    note('Test skipped — config saved without live verification.', 'Test');
    return;
  }

  // Pre-flight: daemon must be running. Re-using WIZ.2's snapshot avoids
  // a second pidfile + sock probe (race-free: detection happened seconds
  // ago, and a daemon that died in the interval is the user's problem to
  // surface — we'll catch it in the RPC call anyway).
  if (!deps.daemonState.running) {
    note(daemonNotRunningHint(deps.daemonState.pidPath), 'Test');
    return;
  }

  const projectUuid = await resolveProjectUuid({
    cwd: deps.cwd ?? process.cwd(),
    env,
  });
  if (projectUuid === null) {
    note(noProjectUuidHint(), 'Test');
    return;
  }

  const loadRouting = deps.loadRouting ?? loadProjectChatRouting;
  const send = deps.send ?? sendViaDaemonSocket;

  const s = spinner();
  s.start('Sending test message via chat-daemon RPC...');
  try {
    const { channel, threadId } = await resolveChannel({
      channel: TEST_CHANNEL,
      projectUuid,
      loadRouting,
    });
    const sendParams: SendTestParams = { channel, text: TEST_TEXT, projectUuid };
    if (threadId !== undefined) sendParams.threadId = threadId;
    const result = await send(sendParams);
    s.stop(
      pc.green(
        `Sent (message_id=${result.message_id}). Check your Telegram chat to confirm receipt.`,
      ),
    );
  } catch (err) {
    s.stop(pc.red(`Test failed: ${describeError(err)}`));
    note(recoveryHintFor(err), 'Test');
  }
}

// ---------------------------------------------------------------------------
// Channel resolution — `project:<platform>` magic → real channel id +
// optional threadId, by reading chat-routing.json on disk.
// ---------------------------------------------------------------------------

export interface ProjectChatRouting {
  telegram?: { report_channel?: string; report_topic_id?: number };
  discord?: { report_channel?: string };
  slack?: { report_channel?: string };
}

interface ResolveChannelDeps {
  channel: string;
  projectUuid: string;
  loadRouting: (uuid: string) => Promise<ProjectChatRouting | null>;
}

async function resolveChannel(
  deps: ResolveChannelDeps,
): Promise<{ channel: string; threadId?: string }> {
  if (!deps.channel.startsWith('project:')) return { channel: deps.channel };
  const platform = deps.channel.slice('project:'.length);
  const routing = await deps.loadRouting(deps.projectUuid);
  if (platform !== 'telegram' && platform !== 'discord' && platform !== 'slack') {
    throw new RoutingMissingError(
      `unsupported project channel platform '${platform}' (expected telegram | discord | slack)`,
    );
  }
  const block = routing?.[platform];
  const resolved = block?.report_channel;
  if (!resolved) {
    throw new RoutingMissingError(
      `no report_channel configured for ${platform} in project ${deps.projectUuid}`,
    );
  }
  const out: { channel: string; threadId?: string } = { channel: resolved };
  if (
    platform === 'telegram' &&
    routing?.telegram?.report_topic_id !== undefined &&
    typeof routing.telegram.report_topic_id === 'number'
  ) {
    out.threadId = String(routing.telegram.report_topic_id);
  }
  return out;
}

/**
 * Default routing reader — `~/.opensquid/projects/<uuid>/chat-routing.json`.
 * Inlined here (a trivial read-and-parse) to keep WIZ.4 self-contained, per
 * the file header. Returns null on missing-file or malformed JSON; never throws.
 */
async function loadProjectChatRouting(uuid: string): Promise<ProjectChatRouting | null> {
  const p = join(OPENSQUID_HOME(), 'projects', uuid, 'chat-routing.json');
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as ProjectChatRouting;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// chat-daemon RPC — one-shot Unix-socket JSON-RPC call. Mirrors the
// `src/mcp/chat-bridge-server.ts` pattern, kept self-contained (same
// inline approach as the routing reader above).
// ---------------------------------------------------------------------------

export interface SendTestParams {
  channel: string;
  text: string;
  projectUuid: string;
  threadId?: string;
}

export interface SendTestResult {
  ok: boolean;
  platform: string;
  message_id: string;
  delivered_at: string;
}

export class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonUnreachableError';
  }
}

export class RoutingMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingMissingError';
  }
}

const RPC_TIMEOUT_MS = 5000;
let rpcCounter = 0;

function daemonSocketPath(): string {
  return join(OPENSQUID_HOME(), 'chat-daemon.sock');
}

async function sendViaDaemonSocket(params: SendTestParams): Promise<SendTestResult> {
  return new Promise((resolveCall, rejectCall) => {
    const id = `wiz4-${++rpcCounter}-${Date.now().toString()}`;
    const req = `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'send',
      params: {
        channel: params.channel,
        text: params.text,
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      },
    })}\n`;
    let sock: Socket | null = null;
    let buffer = '';
    const cleanup = (): void => {
      if (sock) {
        try {
          sock.end();
        } catch {
          /* already closed */
        }
        sock = null;
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectCall(
        new DaemonUnreachableError(`chat-daemon RPC timeout after ${String(RPC_TIMEOUT_MS)}ms`),
      );
    }, RPC_TIMEOUT_MS);
    try {
      sock = connect(daemonSocketPath());
    } catch (err) {
      clearTimeout(timeout);
      rejectCall(
        new DaemonUnreachableError(
          `failed to connect to chat-daemon: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      cleanup();
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
        rejectCall(new DaemonUnreachableError(`${err.code ?? 'EUNK'}: ${err.message}`));
      } else {
        rejectCall(new DaemonUnreachableError(`chat-daemon connection error: ${err.message}`));
      }
    });
    sock.once('connect', () => sock?.write(req));
    sock.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      clearTimeout(timeout);
      cleanup();
      try {
        const parsed = JSON.parse(line) as {
          result?: SendTestResult;
          error?: { code: number; message: string };
        };
        if (parsed.error) {
          rejectCall(
            new Error(
              `chat-daemon RPC error ${String(parsed.error.code)}: ${parsed.error.message}`,
            ),
          );
        } else if (parsed.result) {
          resolveCall(parsed.result);
        } else {
          rejectCall(new Error('chat-daemon returned empty response'));
        }
      } catch (err) {
        rejectCall(
          new Error(
            `failed to parse chat-daemon response: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Error classification — three failure types per WIZ.4 spec:
//   1. daemon unreachable (DaemonUnreachableError name)
//   2. routing missing (RoutingMissingError name)
//   3. bot token invalid (Telegram 401 / Unauthorized propagated through
//      grammy → gateway → daemon → JSON-RPC error)
// Anything else → generic hint pointing at daemon logs.
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function recoveryHintFor(err: unknown): string {
  // Match by name first (works across realm boundaries — dynamic imports
  // may produce a different class identity than instanceof would see).
  const name = err instanceof Error ? err.name : '';
  const message = describeError(err);
  if (name === 'DaemonUnreachableError') {
    return [
      'The chat-daemon is not reachable. Start it with:',
      '  opensquid chat-daemon start',
      'then re-run `opensquid setup chat` and accept the test step.',
    ].join('\n');
  }
  if (name === 'RoutingMissingError') {
    return [
      'No project channel routing is configured. Set it up with:',
      '  opensquid chat_set_project_channel --platform telegram --channel <chat_id>',
      'or edit ~/.opensquid/projects/<uuid>/chat-routing.json directly.',
    ].join('\n');
  }
  if (
    /\b401\b/.test(message) ||
    /Unauthorized/i.test(message) ||
    /bot token/i.test(message) ||
    /invalid token/i.test(message)
  ) {
    return [
      'Telegram rejected the bot token. Fix OPENSQUID_TELEGRAM_BOT_TOKEN in ~/.opensquid/.env:',
      '  1. Visit @BotFather on Telegram → /mybots → select your bot → API Token',
      '  2. Update OPENSQUID_TELEGRAM_BOT_TOKEN=<new_token> in ~/.opensquid/.env (chmod 600)',
      '  3. Restart the chat-daemon: opensquid chat-daemon restart',
    ].join('\n');
  }
  return [
    'The test message failed for an unrecognized reason. Common causes:',
    '  - The bot is not a member of the configured chat',
    '  - The chat-daemon adapter is in outbound-only mode (409 Conflict)',
    '  - Network failure to api.telegram.org',
    'Inspect daemon logs at ~/.opensquid/chat-daemon.log for the underlying call.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Hint text builders
// ---------------------------------------------------------------------------

function daemonNotRunningHint(pidPath: string): string {
  return [
    'The chat-daemon is not running (no live PID at',
    `  ${pidPath}`,
    ').',
    'Start it first, then re-run `opensquid setup chat` and accept the test step:',
    '  opensquid chat-daemon start',
  ].join('\n');
}

function noProjectUuidHint(): string {
  return [
    "Couldn't resolve a project UUID for the test. Either:",
    '  - Set OPENSQUID_PROJECT_UUID to a UUID from ~/.opensquid/projects.json, or',
    '  - cd into a directory that has .opensquid/project.json, or',
    '  - Run `opensquid project init` in your project root to create one.',
  ].join('\n');
}

/**
 * chat-transport daemon worker (T-CHAT-AS-TERMINAL CAT.1b).
 *
 * The long-running process spawned (detached) by `./lifecycle.startDaemon`.
 * Ported from `src.legacy/chat/daemon/worker.ts` onto the new-tree primitives.
 *
 * Lifecycle inside the worker:
 *   1. Write the pidfile (`chat-daemon.pid`) FIRST so a post-spawn status check
 *      sees the worker promptly.
 *   2. Load the umbrella routing config (`loadChannelsConfig`) + build the
 *      transport adapters (`buildChatAdapters`).
 *   3. Subscribe the telegram adapter's RICH transport surface
 *      (`subscribeTransport`) → `routeAndWriteInbound(channelsConfig, msg, now)`
 *      — the inbound path that writes umbrella-keyed inbox rows. (Inbound
 *      DELIVERY to sessions is the file-tail watcher's job, not the daemon's.)
 *   4. `gateway.start()` (kicks the long-poll loops) + start the RPC server
 *      (outbound `send` + `ping` + `list_channels` + `create_topic`).
 *   5. SIGTERM/SIGINT → graceful shutdown: stop adapters, close the server,
 *      remove pidfile + socket.
 *   6. Park on a long no-op interval so the event loop stays alive.
 *
 * Degradation: if `channelsConfig` is null (absent/malformed channels.json) the
 * worker still serves OUTBOUND (gateway.send works) — only inbound routing is
 * affected, and every inbound message orphans (routeAndWriteInbound writes to
 * the orphan inbox when the config can't resolve an umbrella). We pass an empty
 * `{ v:1, umbrellas:[] }` config in that case so every message orphans cleanly
 * rather than crashing the handler.
 *
 * Imports from: node:fs, grammy, ../config, ../factory, ../gateway, ../routing,
 *   ../transport_inbox, ../../runtime/paths, ./protocol, ./rpc_server.
 * Imported by: ./lifecycle.ts (as the worker entry) + tests. NOT wired into the
 * CLI yet (CAT.1d owns CLI/autospawn).
 */

import { promises as fs } from 'node:fs';

import { Bot } from 'grammy';

import { chatDaemonPidPath } from '../../runtime/paths.js';
import { loadChatConfig, loadChatConfigWithSources } from '../config.js';
import { buildChatAdapters, type BuildChatAdaptersResult } from '../factory.js';
import { ChatGateway, type CreateTopicFn } from '../gateway.js';
import { loadChannelsConfig, type ChannelsConfig } from '../routing.js';
import { routeAndWriteInbound } from '../transport_inbox.js';
import type { ChannelAdapter, InboundChatMessage } from '../types.js';

import { RpcServer } from './rpc_server.js';

const DAEMON_VERSION = 'cat-1b';

/** Empty channels config — used when channels.json is absent/malformed so the
 *  inbound handler still runs (every message orphans cleanly). */
const EMPTY_CHANNELS_CONFIG: ChannelsConfig = { v: 1, umbrellas: [] };

interface WorkerState {
  gateway: ChatGateway | null;
  rpcServer: RpcServer | null;
  pidFile: string | null;
  shuttingDown: boolean;
}

function log(line: string): void {
  // The detached parent redirects stdio to the log file; plain stdout lands
  // there.
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

/**
 * Build the telegram `createTopic` seam from the resolved token. Constructs a
 * dedicated grammy Bot for the outbound forum-topic API call (independent of
 * the adapter's long-poll). Returns undefined when telegram has no token.
 */
async function buildCreateTopicSeam(): Promise<CreateTopicFn | undefined> {
  const config = await loadChatConfig();
  const token = config.telegram?.bot_token;
  if (token === undefined || token.length === 0) return undefined;
  const bot = new Bot(token);
  return async (args) => {
    // grammy's `Other<>` param type rejects `?:`-optional props under
    // exactOptionalPropertyTypes; build a plain record + cast at the call.
    const other: Record<string, number | string> = {};
    if (args.iconColor !== undefined) other.icon_color = args.iconColor;
    if (args.iconCustomEmojiId !== undefined) other.icon_custom_emoji_id = args.iconCustomEmojiId;
    const res = await bot.api.createForumTopic(args.chatId, args.name, other);
    return { message_thread_id: res.message_thread_id, name: res.name };
  };
}

/**
 * Wire one rich-transport adapter's `subscribeTransport` to the umbrella inbox
 * writer. Extracted from `runDaemonWorker` as a pure, testable seam: given a
 * subscribe-capable adapter + a channels config, every emitted
 * `InboundChatMessage` is routed + written via `routeAndWriteInbound`. Returns
 * the subscription (caller owns unsubscribe), or null when the adapter has no
 * transport surface.
 */
export async function wireInboundTransport(
  adapter: Pick<ChannelAdapter, 'subscribeTransport'>,
  routingConfig: ChannelsConfig,
  onError?: (msg: InboundChatMessage, err: unknown) => void,
): Promise<{ unsubscribe(): Promise<void> } | null> {
  if (typeof adapter.subscribeTransport !== 'function') return null;
  return adapter.subscribeTransport(async (msg: InboundChatMessage) => {
    try {
      await routeAndWriteInbound(routingConfig, msg, new Date().toISOString());
    } catch (err) {
      if (onError) onError(msg, err);
    }
  });
}

export async function runDaemonWorker(): Promise<never> {
  const pidFile = chatDaemonPidPath();
  const state: WorkerState = {
    gateway: null,
    rpcServer: null,
    pidFile,
    shuttingDown: false,
  };

  // Pidfile FIRST. Truncate-write: any previous pidfile is stale by definition
  // (lifecycle.startDaemon verified no live daemon before spawning us).
  await fs.writeFile(pidFile, `${process.pid}\n`, 'utf8');
  log(`[chat-daemon] worker booted pid=${process.pid} cwd=${process.cwd()}`);

  try {
    // Log which source each token came from (never the value) so operators can
    // debug "which bot is this daemon using" — mirrors the legacy worker.
    try {
      const { sources } = await loadChatConfigWithSources();
      const lines: string[] = [];
      if (sources.telegram) lines.push(`telegram=${sources.telegram}`);
      if (sources.discord) lines.push(`discord=${sources.discord}`);
      if (sources.slack_bot) lines.push(`slack_bot=${sources.slack_bot}`);
      if (sources.slack_app) lines.push(`slack_app=${sources.slack_app}`);
      if (lines.length > 0) {
        log(
          `[chat-daemon] token sources: ${lines.join(' ')}${
            sources.env_file_path ? ` (env-file: ${sources.env_file_path})` : ''
          }`,
        );
      }
    } catch (logErr) {
      log(
        `[chat-daemon] could not log token sources (non-fatal): ${
          logErr instanceof Error ? logErr.message : String(logErr)
        }`,
      );
    }

    // Umbrella routing config. Null ⇒ degrade to an empty config (everything
    // orphans) while still serving outbound.
    const channelsConfig = await loadChannelsConfig();
    if (channelsConfig === null) {
      log('[chat-daemon] channels.json absent/invalid — inbound messages will orphan');
    } else {
      log(`[chat-daemon] channels.json loaded: ${channelsConfig.umbrellas.length} umbrellas`);
    }
    const routingConfig = channelsConfig ?? EMPTY_CHANNELS_CONFIG;

    // Build the transport adapters.
    const built: BuildChatAdaptersResult = await buildChatAdapters();
    log(`[chat-daemon] activating platforms: ${built.activated.join(',') || '(none)'}`);
    for (const issue of built.issues) log(`[chat-daemon] ${issue}`);

    const createTopic = await buildCreateTopicSeam();
    const gateway = new ChatGateway({
      adapters: built.adapters,
      ...(createTopic !== undefined ? { createTopic } : {}),
    });
    state.gateway = gateway;

    // Wire the rich-transport inbound surface → umbrella inbox writer. Only
    // telegram emits InboundChatMessage today.
    const telegram = built.adapters.get('telegram');
    if (telegram !== undefined) {
      const sub = await wireInboundTransport(telegram, routingConfig, (msg, err) =>
        log(
          `[chat-daemon] inbox write failed for ${msg.platform}:${msg.chatId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
      if (sub === null) {
        log('[chat-daemon] telegram adapter has no subscribeTransport surface — inbound disabled');
      }
    }

    // Start adapter long-poll loops, then the RPC server (clients that connect
    // are guaranteed a warmed gateway).
    await gateway.start();
    log('[chat-daemon] gateway start complete');

    const rpcServer = new RpcServer({ gateway, version: DAEMON_VERSION });
    await rpcServer.listen();
    state.rpcServer = rpcServer;
    log(`[chat-daemon] rpc server listening on ${rpcServer.socketAddress}; entering park loop`);
  } catch (err) {
    log(`[chat-daemon] FATAL: startup failed: ${err instanceof Error ? err.stack : String(err)}`);
    await cleanup(state);
    process.exit(1);
  }

  process.on('SIGTERM', () => void shutdown(state, 'SIGTERM'));
  process.on('SIGINT', () => void shutdown(state, 'SIGINT'));

  // Park forever. A long-interval no-op timer is the reliable keep-alive (an
  // unresolved Promise alone won't hold the loop; stdin is /dev/null when
  // spawned detached). Signal handlers fire independently.
  setInterval(() => {
    /* keep-alive heartbeat */
  }, 1 << 30);

  return await new Promise<never>(() => {
    /* never resolves — held alive by the heartbeat interval */
  });
}

async function shutdown(state: WorkerState, signal: string): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log(`[chat-daemon] ${signal} received, shutting down...`);
  try {
    if (state.rpcServer) await state.rpcServer.close();
  } catch (err) {
    log(`[chat-daemon] rpc close error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (state.gateway) await state.gateway.stop();
  } catch (err) {
    log(
      `[chat-daemon] gateway.stop error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await cleanup(state);
  log('[chat-daemon] clean exit');
  process.exit(0);
}

async function cleanup(state: WorkerState): Promise<void> {
  if (state.pidFile !== null) {
    try {
      await fs.unlink(state.pidFile);
    } catch {
      /* race-tolerant */
    }
  }
}

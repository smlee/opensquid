/**
 * Chat-daemon worker entrypoint (v0.7.1 Phase A).
 *
 * Spawned as a detached child by `lifecycle.startDaemon()`. Owns the
 * single long-poll connection per chat platform. The MCP server side
 * stays out of the polling business entirely — outbound RPC (Phase B)
 * and inbox tailing (Phase C) replace the in-process gateway.
 *
 * Lifecycle inside the worker:
 *   1. Write our PID to ~/.opensquid/chat-daemon.pid
 *   2. Build the chat gateway from ~/.opensquid/config.json
 *   3. Start every configured adapter (their long-poll loops run as
 *      side effects of start())
 *   4. Install SIGTERM / SIGINT handlers that stop the gateway and
 *      remove the pidfile before exit
 *   5. Park on process.stdin (which is /dev/null in detached mode)
 *      so the event loop stays alive
 *
 * Crash behavior: any unhandled exception from gateway.start() prints
 * to the (parent-redirected) log file and exits non-zero. The pidfile
 * is cleaned up in the SIGTERM handler — if we crash before installing
 * it, the pidfile may linger, and the next `status` call will report
 * `stale_pid` (lifecycle.startDaemon cleans up stale pidfiles before
 * spawning).
 */

import { promises as fs } from "node:fs";

import { buildChatGateway } from "../factory.js";
import type { ChatGateway } from "../gateway.js";
import { appendToInbox } from "./inbox.js";
import { daemonPaths } from "./lifecycle.js";
import type { InboundMessageNotification } from "./protocol.js";
import { type RoutingIndex, buildRoutingIndex, loadAllProjectChatRouting } from "./routing.js";
import { RpcServer } from "./rpc-server.js";

let gateway: ChatGateway | null = null;
let rpcServer: RpcServer | null = null;
let routingIndex: RoutingIndex = new Map();
let routingPollTimer: NodeJS.Timeout | null = null;
let pidFile: string | null = null;
let shuttingDown = false;

export async function runDaemonWorker(dataRoot?: string): Promise<never> {
  const paths = daemonPaths(dataRoot);
  pidFile = paths.pidFile;

  // Write pidfile FIRST so a status check after spawn sees the worker
  // promptly. Truncate-write is the right semantic — any previous
  // pidfile is stale by definition (we already verified no live daemon
  // existed in lifecycle.startDaemon).
  await fs.writeFile(pidFile, `${process.pid}\n`, "utf8");

  log(`[chat-daemon] worker booted pid=${process.pid} cwd=${process.cwd()}`);

  // Build + start the gateway. If config is empty, no adapters
  // activate and the daemon parks idle — useful for testing the
  // lifecycle without configuring a real bot token.
  try {
    // 0.7.5 (#148): log which source each platform's token came from
    // (env / env-file / config-json) so operators can debug "which
    // bot is this daemon actually using" without exposing the secret.
    try {
      const { loadChatConfigWithSources } = await import("../config.js");
      const { sources } = await loadChatConfigWithSources(dataRoot);
      const lines: string[] = [];
      if (sources.telegram) lines.push(`telegram=${sources.telegram}`);
      if (sources.discord) lines.push(`discord=${sources.discord}`);
      if (sources.slack_bot) lines.push(`slack_bot=${sources.slack_bot}`);
      if (sources.slack_app) lines.push(`slack_app=${sources.slack_app}`);
      if (lines.length) {
        log(
          `[chat-daemon] token sources: ${lines.join(" ")}${sources.env_file_path ? ` (env-file: ${sources.env_file_path})` : ""}`,
        );
      }
    } catch (logErr) {
      log(
        `[chat-daemon] could not log token sources (non-fatal): ${logErr instanceof Error ? logErr.message : logErr}`,
      );
    }
    const built = await buildChatGateway({ dataRoot });
    gateway = built.gateway;
    log(`[chat-daemon] activating platforms: ${built.activated.join(",") || "(none)"}`);
    if (built.issues.length) {
      for (const i of built.issues) {
        log(`[chat-daemon] config issue ${i.platform}.${i.field}: ${i.problem}`);
      }
    }
    // Phase C: load per-project chat-routing.json files and build the
    // chat_id → project_uuid index BEFORE attaching the inbound
    // handler. The handler uses this index to route messages to
    // per-project inboxes.
    routingIndex = await rebuildRoutingIndex(dataRoot);
    log(`[chat-daemon] routing index built: ${routingIndex.size} inbound channels mapped`);
    gateway.onMessage(async (msg) => {
      // v0.5.94 (WAB.2 Part A / TG.1 (a)): DM-first routing.
      //
      // Key precedence:
      //   1. DM key (`telegram:dm:<user_id>`) when the message is a DM —
      //      defined as `msg.channel === "telegram:" + msg.senderId`.
      //      The Telegram adapter formats DM chats as `telegram:<chat_id>`
      //      where chat_id === from.id, so the equality check is the
      //      canonical Telegram private-chat indicator. This also rejects
      //      group-message-from-self spoofs (group chat.id is negative
      //      for supergroups; senderId is positive; they cannot collide).
      //   2. Topic-specific key (`<channel>:<threadId>`) when the message
      //      is in a forum topic.
      //   3. Channel-only key (`<channel>`).
      //
      // Strict topic whitelist preserved per TG.1 (d) — a message in a
      // topic NOT listed by any project's `inbound_topic_ids` will not
      // fall back to the chat-only key (because `collectInboundChannels`
      // does not emit the chat-only key when `inbound_topic_ids` is set
      // on that project). Such messages orphan, which is the documented
      // security-correct default.
      const isDm =
        msg.platform === 'telegram' && msg.channel === `telegram:${msg.senderId}`;
      const dmKey = isDm ? `telegram:dm:${msg.senderId}` : null;
      const topicKey = msg.threadId ? `${msg.channel}:${msg.threadId}` : null;
      const projectUuid =
        (dmKey ? routingIndex.get(dmKey) : undefined) ??
        (topicKey ? routingIndex.get(topicKey) : undefined) ??
        routingIndex.get(msg.channel) ??
        null;
      try {
        const r = await appendToInbox(msg, projectUuid, dataRoot);
        log(
          `[chat-daemon] inbox ← ${msg.channel} (${msg.text.slice(0, 60).replace(/\n/g, " ")}…) → ${r.destination}${r.project_uuid ? "/" + r.project_uuid : ""}`,
        );
      } catch (err) {
        log(
          `[chat-daemon] inbox append failed for ${msg.channel}: ${err instanceof Error ? err.message : err}`,
        );
      }
      // TPS.6 patch 2 (v0.5.126) — broadcast to long-lived UDS
      // subscribers. The JSONL file write above is the durable record;
      // this push is the low-latency delivery. We broadcast on a
      // single key — the most-specific one available: topic-suffixed
      // `<channel>:<threadId>` if present, else bare `<channel>`.
      // This mirrors the routing-index key semantics from
      // `collectInboundChannels`: a project that registers only
      // `chat_id:thread_id` doesn't want to receive messages from
      // other topics in the same supergroup. Wildcard subscribers
      // (chat_ids=[]) see every message regardless of key shape.
      // Fire-and-forget — subscriber write failures are handled by
      // the registry's own socket lifecycle hooks.
      if (rpcServer !== null) {
        const broadcastKey = msg.threadId
          ? `${msg.channel}:${msg.threadId}`
          : msg.channel;
        const notif: InboundMessageNotification = {
          jsonrpc: "2.0",
          method: "inbound_message",
          params: {
            delivery_id: `del-${Date.now().toString()}-${Math.random().toString(36).slice(2, 10)}`,
            message_id: msg.id,
            platform: msg.platform,
            channel: msg.channel,
            ...(msg.threadId !== undefined ? { thread_id: msg.threadId } : {}),
            sender: msg.sender,
            sender_id: msg.senderId,
            text: msg.text,
            received_at: msg.receivedAt.toISOString(),
            mentions_bot: msg.mentionsBot,
          },
        };
        rpcServer.subscribers.broadcast(broadcastKey, notif);
      }
    });
    await gateway.start();
    log(`[chat-daemon] gateway start complete`);

    // v0.5.89 (TG.2) — startup reachability check against each
    // unique inbound chat_id. Catches kicked-from-supergroup (403),
    // stale chat_id (400), and network errors immediately at startup.
    // Best-effort: failures don't block daemon startup, just log
    // warnings so operators can see what's wrong without inspecting
    // hours of empty log noise. The check is Telegram-only for now;
    // Discord/Slack equivalents land in a follow-up if needed.
    try {
      const { verifyTelegramChats, formatReachabilityLine } = await import(
        "./health-check.js"
      );
      const { loadChatConfig } = await import("../config.js");
      const chatConfig = await loadChatConfig(dataRoot);
      const tgToken = chatConfig.telegram?.bot_token;
      // Collect unique chat_ids referenced across all projects' Telegram
      // routing (skip dm: and topic-suffixed keys — getChat takes only
      // the chat_id, no topic).
      const chatIds = new Set<string>();
      const configs = await loadAllProjectChatRouting(dataRoot);
      for (const cfg of configs.values()) {
        for (const id of cfg.telegram?.inbound_chat_ids ?? []) chatIds.add(id);
      }
      if (chatIds.size > 0 && tgToken) {
        const results = await verifyTelegramChats(tgToken, [...chatIds]);
        for (const r of results) log(formatReachabilityLine(r));
      }
    } catch (err) {
      log(
        `[chat-daemon] chat-reachability check skipped (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }

    // RPC server listens for outbound send() calls from per-project
    // MCP servers. Starting it AFTER gateway.start() means clients
    // that connect successfully are guaranteed a fully-warmed gateway.
    rpcServer = new RpcServer({ gateway, dataRoot, version: "v0.7.1-phase-c" });
    await rpcServer.listen();
    // Poll the routing files every 30s so operators can edit a
    // chat-routing.json and have the daemon pick it up without a full
    // restart. Polling is the most portable option (fs.watch behavior
    // varies across macOS/Linux/Windows + recursive support).
    routingPollTimer = setInterval(() => {
      void (async () => {
        try {
          const next = await rebuildRoutingIndex(dataRoot);
          if (!sameIndex(routingIndex, next)) {
            routingIndex = next;
            log(`[chat-daemon] routing reload: ${routingIndex.size} inbound channels mapped`);
          }
        } catch (err) {
          log(
            `[chat-daemon] routing reload failed (non-fatal): ${err instanceof Error ? err.message : err}`,
          );
        }
      })();
    }, 30_000);
    log(`[chat-daemon] rpc server listening; entering park loop`);
  } catch (err) {
    log(`[chat-daemon] FATAL: gateway start failed: ${err instanceof Error ? err.stack : err}`);
    await cleanup();
    process.exit(1);
  }

  // Signal handlers. SIGTERM = graceful, SIGINT = also graceful (for
  // manual `kill` during dev). Each calls cleanup() exactly once.
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Park forever. process.stdin.resume() does NOT work here because
  // the parent spawned us with `stdio: ['ignore', ...]` — there's no
  // FD 0 to poll. An unresolved Promise alone won't hold the event
  // loop either; Node exits when nothing's scheduled. The reliable
  // pattern is a long-interval no-op timer (~12 days per tick); the
  // tick is a microsecond of CPU and easily survives clock jitter.
  // Signal handlers are independently registered above and still fire.
  setInterval(() => {
    /* keep-alive heartbeat */
  }, 1 << 30);

  // TypeScript demands a return path even though we never reach here.
  return await new Promise<never>(() => {
    /* never resolves; held alive by the heartbeat interval */
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[chat-daemon] ${signal} received, shutting down...`);
  if (routingPollTimer) clearInterval(routingPollTimer);
  // TPS.6 patch 2 (v0.5.126) — tell subscribers we're going away
  // BEFORE closing the RPC server. The shutdown notification gives
  // MCP bridges a clean signal to back off their reconnect loop
  // instead of treating the disconnect as transient and immediately
  // retrying.
  try {
    if (rpcServer) rpcServer.subscribers.shutdown(signal);
  } catch (err) {
    log(
      `[chat-daemon] subscriber shutdown notify error (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
  try {
    if (rpcServer) await rpcServer.close();
  } catch (err) {
    log(`[chat-daemon] rpc close error (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
  try {
    if (gateway) await gateway.shutdown();
  } catch (err) {
    log(
      `[chat-daemon] gateway.shutdown error (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }
  await cleanup();
  log(`[chat-daemon] clean exit`);
  process.exit(0);
}

async function cleanup(): Promise<void> {
  if (pidFile) {
    try {
      await fs.unlink(pidFile);
    } catch {
      /* race-tolerant */
    }
  }
}

function log(line: string): void {
  // stdio is already redirected to the log file by the parent's spawn
  // options; plain console.log lands in the right place.
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

async function rebuildRoutingIndex(dataRoot?: string): Promise<RoutingIndex> {
  const cfgs = await loadAllProjectChatRouting(dataRoot);
  const { recordCollision } = await import("./collisions.js");
  return buildRoutingIndex(cfgs, (info) => {
    log(
      `[chat-daemon] routing collision: ${info.channel_key} existing=${info.existing_uuid} newcomer=${info.newcomer_uuid} (latter wins)`,
    );
    // Fire-and-forget: persist + notify happen async; the routing
    // rebuild must not wait. recordCollision swallows its own errors
    // (stderr-logged) so this `void` is intentional.
    void recordCollision({
      info,
      dataRoot,
      ...(gateway !== null ? { gateway } : {}),
    });
  });
}

function sameIndex(a: RoutingIndex, b: RoutingIndex): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

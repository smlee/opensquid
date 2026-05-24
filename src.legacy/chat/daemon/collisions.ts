/**
 * collisions.ts — TPS.5 (v0.5.124).
 *
 * Surfaces `buildRoutingIndex` collisions through three durable channels
 * instead of the one (daemon log) v0.5.x had. Replaces the "warning lost
 * in a log nobody tails" failure mode with:
 *
 *   1. `~/.opensquid/collisions.jsonl` — append-only audit trail.
 *   2. Telegram general-topic notification — debounced 60min per key
 *      so a long-standing collision pings the operator once an hour,
 *      not every routing reload.
 *   3. MCP `chat_poll_inbox` — prepends warning lines to the poll
 *      response when an unresolved collision affects the active
 *      workspace (read path lives in `src/mcp/chat-bridge-server.ts`).
 *
 * Source of truth is the JSONL file: write-once-on-every-collision +
 * read-tail-on-every-poll. Debounce state is derived from the records
 * themselves (last `notified_via_telegram=true` timestamp for the same
 * channel_key) so daemon restarts don't reset the cooldown.
 *
 * Concurrency: single writer (the chat-daemon worker), many readers
 * (per-project MCP bridge subprocesses). POSIX O_APPEND keeps
 * sub-PIPE_BUF writes atomic. Malformed lines are skipped on read.
 *
 * Failure isolation: NEVER block the routing rebuild. Disk full →
 * stderr log + continue. Telegram send failure → log + the JSONL line
 * (which already wrote) still surfaces the collision on next MCP poll.
 *
 * Rebuild path: same ad-hoc tsc invocation as the other src.legacy/
 * modules — see `src.legacy/chat/adapters/telegram.ts` header.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ChatGateway } from "../gateway.js";
import { loadAllProjectChatRouting, type ProjectChatRouting } from "./routing.js";
import type { CollisionInfo } from "./routing.js";

// ---------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------

/**
 * One routing-collision line in `collisions.jsonl`. `v: 1` is a schema
 * version pinned so future readers can detect + skip incompatible
 * shapes.
 *
 * TPS.7 added a tagged union to the file (see `TopicGoneEvent` below).
 * Existing on-disk `CollisionEntry` records pre-date the `kind` field;
 * the loader defaults missing `kind` to `"collision"` for back-compat.
 * New writes from TPS.5's `recordCollision` continue to omit `kind` to
 * keep wire-format diffs minimal (the absence of `kind` IS the signal).
 */
export interface CollisionEntry {
  v: 1;
  /** Implicit "collision" — older writes lack this field; readers default. */
  kind?: "collision";
  occurred_at: string;
  channel_key: string;
  /** All project_uuids known to have claimed this key (existing + newcomer). */
  claimants: string[];
  /** The project_uuid that now holds the slot (newcomer wins per `buildRoutingIndex`). */
  winner_uuid: string;
  /**
   * Whether a Telegram notification fired for THIS record. Used as the
   * debounce signal: scan recent records for the same key with
   * `notified_via_telegram=true`; suppress new notifications while
   * within the debounce window.
   */
  notified_via_telegram: boolean;
}

/**
 * TPS.7 (v0.5.130) — topic-gone event line in `collisions.jsonl`.
 *
 * Written when the daemon's RPC `send` handler catches a `TopicGoneError`
 * from the Telegram adapter (Bot API 400: "message thread not found").
 * Co-located with `CollisionEntry` in the same file because both surface
 * the same way: append-only audit trail + debounced Telegram notify +
 * MCP `chat_poll_inbox` warning prepend.
 *
 * Discriminator: `kind: "topic_gone"`. The auto-rebind itself happens
 * later on the next MCP-bridge subscribe via TPS.6's auto-boot path —
 * this record is the *signal* that a binding was cleared, not the act
 * of rebinding.
 */
export interface TopicGoneEvent {
  v: 1;
  kind: "topic_gone";
  occurred_at: string;
  /** "telegram:<chat_id>:<topic_id>" — same channel_key shape as CollisionEntry. */
  channel_key: string;
  /** Workspace whose `auto_bound` was just cleared. */
  workspace_uuid: string;
  /** The supergroup chat_id (without "telegram:" prefix). */
  chat_id: string;
  /** The thread/topic id that disappeared. */
  topic_id: number;
  /** Bot API description string for forensics (e.g. "Bad Request: message thread not found"). */
  underlying_description: string;
  /**
   * Whether a Telegram notification fired for THIS record. Same
   * debounce semantics as `CollisionEntry.notified_via_telegram`.
   */
  notified_via_telegram: boolean;
}

/** Discriminated union of everything that lives in collisions.jsonl. */
export type CollisionsLine = CollisionEntry | TopicGoneEvent;

export const DEBOUNCE_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------

export function collisionsPath(dataRoot?: string): string {
  const root = dataRoot ?? process.env.OPENSQUID_HOME;
  if (!root || root.length === 0) {
    throw new Error("collisionsPath: dataRoot not provided and OPENSQUID_HOME unset");
  }
  return path.join(root, "collisions.jsonl");
}

// ---------------------------------------------------------------------
// Read / debounce
// ---------------------------------------------------------------------

/**
 * Read the full discriminated union from `collisions.jsonl`, dropping
 * malformed lines and unknown-shape records. Returns [] on missing
 * file. TPS.7 (v0.5.130) — supersedes pre-TPS.7 single-type readers.
 *
 * Records without an explicit `kind` are treated as `CollisionEntry`
 * (back-compat with TPS.5 writes).
 */
export async function loadAllCollisionsLines(dataRoot?: string): Promise<CollisionsLine[]> {
  const p = collisionsPath(dataRoot);
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: CollisionsLine[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as CollisionsLine;
      if (parsed.v !== 1 || typeof parsed.channel_key !== "string") continue;
      const kind = (parsed as { kind?: string }).kind;
      if (kind === "topic_gone") {
        const ev = parsed as TopicGoneEvent;
        if (
          typeof ev.workspace_uuid === "string" &&
          typeof ev.chat_id === "string" &&
          typeof ev.topic_id === "number"
        ) {
          out.push(ev);
        }
      } else {
        // kind missing OR explicitly "collision" — treat as CollisionEntry.
        const ent = parsed as CollisionEntry;
        if (Array.isArray(ent.claimants) && typeof ent.winner_uuid === "string") {
          out.push(ent);
        }
      }
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * TPS.5 back-compat reader — filters `loadAllCollisionsLines` to just
 * `CollisionEntry` records (drops TPS.7 `TopicGoneEvent` lines). Used
 * by the debounce scan in `recordCollision` so a recent topic-gone
 * event doesn't suppress a fresh collision notification.
 */
export async function loadAllCollisions(dataRoot?: string): Promise<CollisionEntry[]> {
  const all = await loadAllCollisionsLines(dataRoot);
  return all.filter((line): line is CollisionEntry => {
    const kind = (line as { kind?: string }).kind;
    return kind === undefined || kind === "collision";
  });
}

/**
 * TPS.7 (v0.5.130) — read `TopicGoneEvent` records only. Used by the
 * debounce scan in `recordTopicGoneEvent` and by MCP `chat_poll_inbox`
 * for stale-topic warnings.
 */
export async function loadAllTopicGoneEvents(dataRoot?: string): Promise<TopicGoneEvent[]> {
  const all = await loadAllCollisionsLines(dataRoot);
  return all.filter((line): line is TopicGoneEvent => {
    return (line as { kind?: string }).kind === "topic_gone";
  });
}

/**
 * MCP-side helper: return collisions whose `occurred_at` is within
 * `maxAgeMinutes`. Used by `chat_poll_inbox` to prepend warnings
 * about ACTIVE (still-recent) collisions to its response.
 *
 * Default window is 24 hours — long enough that the user sees the
 * warning across a typical work session without surfacing ancient
 * collisions that the user already fixed.
 */
export async function getRecentCollisions(
  maxAgeMinutes = 24 * 60,
  dataRoot?: string,
): Promise<CollisionEntry[]> {
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  const all = await loadAllCollisions(dataRoot);
  return all.filter((e) => {
    const t = Date.parse(e.occurred_at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * TPS.7 (v0.5.130) — same default window as `getRecentCollisions` but
 * for `TopicGoneEvent` records. Surfaced through MCP `chat_poll_inbox`
 * so the agent learns "your topic was deleted; daemon cleared the
 * binding; next session will rebind automatically" within the same
 * 24h window.
 */
export async function getRecentTopicGoneEvents(
  maxAgeMinutes = 24 * 60,
  dataRoot?: string,
): Promise<TopicGoneEvent[]> {
  const cutoff = Date.now() - maxAgeMinutes * 60 * 1000;
  const all = await loadAllTopicGoneEvents(dataRoot);
  return all.filter((e) => {
    const t = Date.parse(e.occurred_at);
    return Number.isFinite(t) && t >= cutoff;
  });
}

/**
 * Find the most recent record (if any) that fired a Telegram
 * notification for the same channel_key. Used to decide whether a
 * new collision is within the debounce window.
 */
function lastNotifiedAt(
  entries: CollisionEntry[],
  channelKey: string,
): number | null {
  let best: number | null = null;
  for (const e of entries) {
    if (e.channel_key !== channelKey) continue;
    if (!e.notified_via_telegram) continue;
    const t = Date.parse(e.occurred_at);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best;
}

// ---------------------------------------------------------------------
// Append + notify
// ---------------------------------------------------------------------

export interface RecordCollisionArgs {
  info: CollisionInfo;
  dataRoot?: string;
  /**
   * Optional gateway for the Telegram notification. If absent (or no
   * project has a `report_channel` configured), the JSONL record still
   * writes and the MCP-side surface still fires.
   */
  gateway?: ChatGateway;
  /** Injected clock for tests. Defaults to Date.now(). */
  nowMs?: () => number;
}

/**
 * Record a collision: append a structured JSONL entry, and (if outside
 * the debounce window + a Telegram report_channel exists) fire a
 * one-shot notification to the supergroup's general topic. Returns
 * the entry that was appended.
 *
 * NEVER throws past the caller: persist failures log to stderr; send
 * failures log + flip the `notified_via_telegram` flag back to false
 * for the persisted record. The routing rebuild that triggered this
 * call must always complete.
 */
export async function recordCollision(args: RecordCollisionArgs): Promise<CollisionEntry> {
  const now = (args.nowMs ?? Date.now)();
  const existing = await loadAllCollisions(args.dataRoot).catch(() => [] as CollisionEntry[]);
  const lastNotified = lastNotifiedAt(existing, args.info.channel_key);
  const withinDebounce = lastNotified !== null && now - lastNotified < DEBOUNCE_WINDOW_MS;

  // Decide whether we WILL notify this time. The final
  // `notified_via_telegram` value reflects the send result (see below).
  const shouldNotify = !withinDebounce && args.gateway !== undefined;

  // Try Telegram notification BEFORE appending so the persisted flag
  // reflects reality. If gateway send fails (rate limit, bot kicked),
  // we still record the collision with notified=false so the next
  // routing reload may retry past the debounce window.
  let didNotify = false;
  if (shouldNotify && args.gateway) {
    try {
      didNotify = await notifyCollisionViaTelegram({
        gateway: args.gateway,
        info: args.info,
        dataRoot: args.dataRoot,
      });
    } catch (err) {
      process.stderr.write(
        `[collisions] telegram notify failed for ${args.info.channel_key}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      didNotify = false;
    }
  }

  const entry: CollisionEntry = {
    v: 1,
    occurred_at: new Date(now).toISOString(),
    channel_key: args.info.channel_key,
    claimants: [args.info.existing_uuid, args.info.newcomer_uuid],
    winner_uuid: args.info.newcomer_uuid,
    notified_via_telegram: didNotify,
  };

  try {
    await appendCollisionsLine(entry, args.dataRoot);
  } catch (err) {
    process.stderr.write(
      `[collisions] persist failed for ${args.info.channel_key}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
  return entry;
}

// ---------------------------------------------------------------------
// Telegram notification (one-shot via daemon's in-process gateway)
// ---------------------------------------------------------------------

interface NotifyArgs {
  gateway: ChatGateway;
  info: CollisionInfo;
  dataRoot?: string;
}

/**
 * Find ANY project with a Telegram `report_channel` configured and
 * send the collision notification to its general topic. Picks the
 * first match deterministically (Map insertion order, which is
 * filename-sorted in `loadAllProjectChatRouting`) so notifications
 * are stable across daemon restarts.
 *
 * Returns true iff the send succeeded. Catches everything — caller
 * folds the failure into the JSONL record via `notified_via_telegram`.
 */
async function notifyCollisionViaTelegram(args: NotifyArgs): Promise<boolean> {
  const configs = await loadAllProjectChatRouting(args.dataRoot);
  const target = pickNotificationTarget(configs);
  if (target === null) return false;

  const text = formatCollisionMessage(args.info, target.workspaceLabel);
  try {
    // Force the general topic — collisions are admin-tier notifications,
    // not workspace-scoped chatter. Telegram represents the general
    // topic as the chat itself with NO threadId, so we intentionally
    // omit it (don't pass report_topic_id even if set).
    await args.gateway.send({ channel: target.channel, text });
    return true;
  } catch {
    return false;
  }
}

interface NotificationTarget {
  channel: string;
  workspaceLabel: string;
}

function pickNotificationTarget(
  configs: Map<string, ProjectChatRouting>,
): NotificationTarget | null {
  for (const [uuid, cfg] of configs) {
    const ch = cfg.telegram?.report_channel;
    if (ch && ch.length > 0) {
      return { channel: ch, workspaceLabel: uuid };
    }
  }
  return null;
}

function formatCollisionMessage(info: CollisionInfo, sourceLabel: string): string {
  return [
    "⚠️ opensquid routing collision detected",
    "",
    `  channel: ${info.channel_key}`,
    `  existing: ${info.existing_uuid}`,
    `  newcomer: ${info.newcomer_uuid} (will win)`,
    "",
    `Two workspaces claim the same inbound channel. Inbound messages route to`,
    `the newer claimant; the older one will see nothing. Edit one of the`,
    `chat-routing.json files under ~/.opensquid/projects/ to resolve.`,
    "",
    `(notified by ${sourceLabel})`,
  ].join("\n");
}

// ---------------------------------------------------------------------
// TPS.7 (v0.5.130) — topic-gone append + notify
// ---------------------------------------------------------------------

export interface RecordTopicGoneArgs {
  workspaceUuid: string;
  chatId: string;
  topicId: number;
  underlyingDescription: string;
  dataRoot?: string;
  /** Optional gateway for the Telegram notification. */
  gateway?: ChatGateway;
  /** Injected clock for tests. */
  nowMs?: () => number;
}

/**
 * Record a topic-gone event: append a structured JSONL entry to
 * collisions.jsonl, and (if outside the debounce window + a Telegram
 * report_channel exists) fire a one-shot notification to the
 * supergroup's general topic. Returns the entry that was appended.
 *
 * Mirrors `recordCollision` semantics — NEVER throws past the caller.
 * Persist failures log to stderr; send failures flip the
 * `notified_via_telegram` flag to false. The async caller in
 * `rpc-server.ts:handleTopicGone` doesn't await any user-visible work.
 *
 * Debounce key: the same `channel_key` shape used by collisions
 * (`telegram:<chat_id>:<topic_id>`). Within `DEBOUNCE_WINDOW_MS`,
 * additional topic-gone events for the same channel record to JSONL
 * but skip the Telegram ping — the user already got the alert.
 */
export async function recordTopicGoneEvent(args: RecordTopicGoneArgs): Promise<TopicGoneEvent> {
  const now = (args.nowMs ?? Date.now)();
  const channelKey = `telegram:${args.chatId}:${args.topicId}`;
  const existing = await loadAllTopicGoneEvents(args.dataRoot).catch(() => [] as TopicGoneEvent[]);
  const lastNotified = lastTopicGoneNotifiedAt(existing, channelKey);
  const withinDebounce = lastNotified !== null && now - lastNotified < DEBOUNCE_WINDOW_MS;

  const shouldNotify = !withinDebounce && args.gateway !== undefined;
  let didNotify = false;
  if (shouldNotify && args.gateway) {
    try {
      didNotify = await notifyTopicGoneViaTelegram({
        gateway: args.gateway,
        workspaceUuid: args.workspaceUuid,
        chatId: args.chatId,
        topicId: args.topicId,
        dataRoot: args.dataRoot,
      });
    } catch (err) {
      process.stderr.write(
        `[collisions] topic-gone telegram notify failed for ${channelKey}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      didNotify = false;
    }
  }

  const entry: TopicGoneEvent = {
    v: 1,
    kind: "topic_gone",
    occurred_at: new Date(now).toISOString(),
    channel_key: channelKey,
    workspace_uuid: args.workspaceUuid,
    chat_id: args.chatId,
    topic_id: args.topicId,
    underlying_description: args.underlyingDescription,
    notified_via_telegram: didNotify,
  };

  try {
    await appendCollisionsLine(entry, args.dataRoot);
  } catch (err) {
    process.stderr.write(
      `[collisions] topic-gone persist failed for ${channelKey}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
  return entry;
}

function lastTopicGoneNotifiedAt(events: TopicGoneEvent[], channelKey: string): number | null {
  let best: number | null = null;
  for (const e of events) {
    if (e.channel_key !== channelKey) continue;
    if (!e.notified_via_telegram) continue;
    const t = Date.parse(e.occurred_at);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best;
}

async function appendCollisionsLine(line: CollisionsLine, dataRoot?: string): Promise<void> {
  const p = collisionsPath(dataRoot);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.appendFile(p, JSON.stringify(line) + "\n", "utf8");
}

interface NotifyTopicGoneArgs {
  gateway: ChatGateway;
  workspaceUuid: string;
  chatId: string;
  topicId: number;
  dataRoot?: string;
}

async function notifyTopicGoneViaTelegram(args: NotifyTopicGoneArgs): Promise<boolean> {
  const configs = await loadAllProjectChatRouting(args.dataRoot);
  const target = pickNotificationTarget(configs);
  if (target === null) return false;

  const text = formatTopicGoneMessage(args);
  try {
    await args.gateway.send({ channel: target.channel, text });
    return true;
  } catch {
    return false;
  }
}

function formatTopicGoneMessage(args: NotifyTopicGoneArgs): string {
  return [
    "🧹 opensquid topic binding cleared (topic was deleted)",
    "",
    `  workspace: ${args.workspaceUuid}`,
    `  chat_id: ${args.chatId}`,
    `  topic_id: ${args.topicId} (no longer exists)`,
    "",
    `The bound forum topic was deleted from the supergroup. The daemon`,
    `cleared the stale binding; the next MCP-bridge subscribe for this`,
    `workspace will auto-rebind to a fresh topic (TPS.6 auto-boot).`,
  ].join("\n");
}

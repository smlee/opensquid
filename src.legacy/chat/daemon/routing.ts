/**
 * Per-project chat routing (v0.7.1 Phase C).
 *
 * Note on src.legacy/ placement (TG.1 (f) / WAB.2): the "legacy" label is a
 * pre-0.5.x architecture marker, NOT a "dead code" marker. The chat-daemon
 * compiled from `src.legacy/chat/` is the production runtime for inbound
 * Telegram + outbound chat_send. This file is actively maintained — see
 * `inbound_dm_user_ids` (v0.5.94 / WAB.2 Part A) below.
 *
 * Schema on disk: `~/.opensquid/projects/<uuid>/chat-routing.json`
 *
 * ```jsonc
 * {
 *   "telegram": {
 *     "report_channel": "telegram:-1001234567890",  // outbound default
 *     "report_topic_id": 15,                          // forum-topic id for outbound
 *     "inbound_chat_ids": ["-1001234567890"],        // accepts inbound from these chats
 *     "inbound_topic_ids": [15],                      // strict whitelist when set
 *     "inbound_dm_user_ids": ["8075471258"]          // v0.5.94 — DM allowlist
 *   },
 *   "discord": {
 *     "report_channel": "discord:1234567890",
 *     "inbound_channel_ids": ["1234567890"]
 *   },
 *   "slack": {
 *     "report_channel": "slack:C012345",
 *     "inbound_channel_ids": ["C012345"]
 *   }
 * }
 * ```
 *
 * Routing rules:
 *   - **Outbound** (agent → chat): the MCP tool picks `report_channel`
 *     from the active project's routing config. (Phase E wires the MCP
 *     tools; this module just exposes the lookup.)
 *   - **Inbound** (chat → agent): the daemon's gateway.onMessage handler
 *     constructs a routing key (DM key, topic key, or chat-only key per
 *     TG.1 policy decision (a)+(d)) and looks it up in the index this
 *     module builds. Match → JSONL append to that project's inbox.
 *     No match → JSONL append to the orphan inbox.
 *
 * UUID is the stable primary key because the project's human-friendly
 * `id` can be renamed via `opensquid project init` without rewriting
 * routing files.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../../codex/store.js";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface TelegramRouting {
  report_channel?: string;
  /**
   * v0.7.2 — forum-topic id within the supergroup (`report_channel`)
   * that outbound reports for this project should post to. When set,
   * outbound `chat_send` via `project:telegram` includes the
   * `message_thread_id` so the message lands in the right topic.
   */
  report_topic_id?: number;
  inbound_chat_ids?: string[];
  /**
   * v0.7.2 — when set, ONLY inbound messages with one of these
   * `message_thread_id` values route to this project. Empty/unset means
   * accept any topic (legacy v0.7.1 behavior — accepts all messages
   * from the listed `inbound_chat_ids`).
   */
  inbound_topic_ids?: number[];
  /**
   * v0.5.94 (WAB.2 Part A / TG.1 decision (a)) — allowlist of user IDs
   * whose Telegram DMs route to this project. A "DM" is detected when the
   * inbound `chat.id === from.id` (Telegram's canonical private-chat
   * shape). On match, the routing key is `telegram:dm:<user_id>`. Group
   * messages from the same user use `inbound_chat_ids` + topic semantics
   * — this field does NOT shadow group routing.
   *
   * Schema is additive: existing chat-routing.json files without this
   * field continue to load and route correctly (DM routing simply
   * disabled for that project).
   */
  inbound_dm_user_ids?: string[];
}

export interface DiscordRouting {
  report_channel?: string;
  inbound_channel_ids?: string[];
}

export interface SlackRouting {
  report_channel?: string;
  inbound_channel_ids?: string[];
}

export interface ProjectChatRouting {
  telegram?: TelegramRouting;
  discord?: DiscordRouting;
  slack?: SlackRouting;
}

/**
 * In-memory index built from all per-project routing files. Used by
 * the daemon's inbound handler to decide which project's inbox an
 * incoming message belongs to.
 *
 * Key shape: `<platform>:<native_chat_id>` — same shape as ChannelId
 * so the daemon can index directly off the parsed channel field of
 * an inbound ChatMessage.
 */
export type RoutingIndex = Map<string, string /* project_uuid */>;

// ---------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------

export function projectsRootPath(dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "projects");
}

export function projectChatRoutingPath(projectUuid: string, dataRoot?: string): string {
  return path.join(projectsRootPath(dataRoot), projectUuid, "chat-routing.json");
}

export function projectInboxDir(projectUuid: string, dataRoot?: string): string {
  return path.join(projectsRootPath(dataRoot), projectUuid, "inbox");
}

export function orphanInboxDir(dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "inbox", "orphan");
}

// ---------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------

/**
 * Read a single project's routing config. Returns null if the file
 * doesn't exist or fails to parse — both are non-fatal (the project
 * just doesn't have routing configured, so inbound for it goes to
 * the orphan inbox).
 */
export async function loadProjectChatRouting(
  projectUuid: string,
  dataRoot?: string,
): Promise<ProjectChatRouting | null> {
  const p = projectChatRoutingPath(projectUuid, dataRoot);
  try {
    const raw = await fs.readFile(p, "utf8");
    return JSON.parse(raw) as ProjectChatRouting;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Malformed JSON: log on stderr (daemon log) and fall back to
    // no-routing. Better than crashing the daemon over a bad file.
    process.stderr.write(
      `[chat-routing] failed to parse ${p}: ${err instanceof Error ? err.message : err}\n`,
    );
    return null;
  }
}

/**
 * Scan `~/.opensquid/projects/*` and load every routing file that
 * exists. Returns a Map keyed by project_uuid → routing config. Used
 * by `buildRoutingIndex` to construct the lookup map.
 */
export async function loadAllProjectChatRouting(
  dataRoot?: string,
): Promise<Map<string, ProjectChatRouting>> {
  const root = projectsRootPath(dataRoot);
  const out = new Map<string, ProjectChatRouting>();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const uuid of entries) {
    // Skip hidden files; only consider directory-like entries.
    if (uuid.startsWith(".")) continue;
    const routing = await loadProjectChatRouting(uuid, dataRoot);
    if (routing) out.set(uuid, routing);
  }
  return out;
}

/**
 * Build the inbound chat_id → project_uuid lookup map from a collection
 * of per-project routing configs. Used at daemon startup AND whenever
 * the file watcher fires on a routing change.
 *
 * Collision handling: if two projects claim the same inbound chat_id,
 * the LATER one wins (Map.set overwrite). Surface a warning via the
 * optional `onWarn` callback so the operator can fix it.
 */
export function buildRoutingIndex(
  configs: Map<string, ProjectChatRouting>,
  onWarn?: (message: string) => void,
): RoutingIndex {
  const idx: RoutingIndex = new Map();
  for (const [projectUuid, cfg] of configs) {
    for (const channelKey of collectInboundChannels(cfg)) {
      const existing = idx.get(channelKey);
      if (existing && existing !== projectUuid && onWarn) {
        onWarn(
          `chat_id collision: ${channelKey} claimed by both project ${existing} and ${projectUuid} (latter wins)`,
        );
      }
      idx.set(channelKey, projectUuid);
    }
  }
  return idx;
}

/**
 * Yield each inbound channel id (in `<platform>:<native_id>` shape) a
 * routing config declares.
 */
export function collectInboundChannels(cfg: ProjectChatRouting): string[] {
  const out: string[] = [];
  if (cfg.telegram?.inbound_chat_ids) {
    // v0.7.2: if inbound_topic_ids is set, emit a more-specific key per
    // (chat_id, topic_id) tuple so the routing index can distinguish
    // multiple projects sharing one supergroup. Otherwise emit the
    // chat-only key (v0.7.1 behavior).
    const topicIds = cfg.telegram.inbound_topic_ids;
    for (const chatId of cfg.telegram.inbound_chat_ids) {
      if (topicIds && topicIds.length > 0) {
        for (const tid of topicIds) out.push(`telegram:${chatId}:${tid}`);
      } else {
        out.push(`telegram:${chatId}`);
      }
    }
  }
  // v0.5.94 (WAB.2 Part A / TG.1 (a)): emit DM allowlist keys as
  // `telegram:dm:<user_id>`. Worker's onMessage detects DMs (chat.id ===
  // from.id) and looks up against this key. Separate key namespace from
  // `telegram:<chat_id>` so a user whose user_id collides with a
  // supergroup chat_id (unlikely but possible — both are integers) does
  // not silently cross-route.
  if (cfg.telegram?.inbound_dm_user_ids) {
    for (const uid of cfg.telegram.inbound_dm_user_ids) out.push(`telegram:dm:${uid}`);
  }
  if (cfg.discord?.inbound_channel_ids) {
    for (const id of cfg.discord.inbound_channel_ids) out.push(`discord:${id}`);
  }
  if (cfg.slack?.inbound_channel_ids) {
    for (const id of cfg.slack.inbound_channel_ids) out.push(`slack:${id}`);
  }
  return out;
}

// ---------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------

/**
 * Persist a project's routing config. Creates the project directory if
 * missing. Atomic-ish via write-then-rename so partial writes never
 * leave a corrupt file.
 */
export async function saveProjectChatRouting(
  projectUuid: string,
  routing: ProjectChatRouting,
  dataRoot?: string,
): Promise<{ path: string }> {
  const filePath = projectChatRoutingPath(projectUuid, dataRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(routing, null, 2)}\n`, "utf8");
  await fs.rename(tmp, filePath);
  return { path: filePath };
}

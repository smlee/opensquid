/**
 * Per-project chat routing (v0.7.1 Phase C).
 *
 * Schema on disk: `~/.opensquid/projects/<uuid>/chat-routing.json`
 *
 * ```jsonc
 * {
 *   "telegram": {
 *     "report_channel": "telegram:-1001234567890",  // outbound default
 *     "inbound_chat_ids": ["-1001234567890"]        // accepts inbound from these chats
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
 *     looks up the source chat_id in the chat_id → project_uuid index
 *     this module builds. Match → JSONL append to that project's inbox.
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
  inbound_chat_ids?: string[];
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
    for (const id of cfg.telegram.inbound_chat_ids) out.push(`telegram:${id}`);
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

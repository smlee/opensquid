/**
 * Per-project inbound message inbox (v0.7.1 Phase C).
 *
 * The daemon receives inbound messages from all activated chat
 * platforms via gateway.onMessage. This module is the write side:
 * given a destination project (or "orphan" if no routing match),
 * atomically append the message to its JSONL inbox.
 *
 * Read side lives in Phase E (the MCP `chat_poll_inbox` tool that
 * per-project servers call to surface inbound messages to their
 * agent).
 *
 * File layout:
 *   ~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl  (per-project)
 *   ~/.opensquid/inbox/orphan/<platform>.jsonl           (catch-all)
 *
 * One line per message; line format is the JSON serialization of the
 * `InboxMessage` shape below. Newline-delimited so consumers can tail
 * incrementally without seeing partial writes (POSIX guarantees O_APPEND
 * writes ≤ PIPE_BUF are atomic; our messages are typically a few
 * hundred bytes, well under the 4096-byte threshold).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ChatMessage } from "../gateway.js";
import { orphanInboxDir, projectInboxDir } from "./routing.js";

export interface InboxMessage {
  /** Wire-format version; bump when the line format changes. */
  v: 1;
  /** Platform-stable message id (Telegram message_id, Slack ts, etc.). */
  id: string;
  /** Stable platform identifier. */
  platform: string;
  /** Full channel id (`<platform>:<native>`) the message arrived on. */
  channel: string;
  /** Display name of sender; falls back to native id when display is absent. */
  sender: string;
  /** Native sender id (Telegram user_id, Slack user, etc.). */
  sender_id: string;
  /** Message body text. */
  text: string;
  /** Wall-clock the platform stamped the message with (ISO 8601). */
  received_at: string;
  /** Daemon-side wall-clock the message hit the inbox (ISO 8601). */
  enqueued_at: string;
  /** True when the message contained an @-mention of the bot. */
  mentions_bot: boolean;
}

export interface AppendResult {
  /** Where the message ended up. */
  destination: "project" | "orphan";
  /** Project uuid (only when destination=project). */
  project_uuid?: string;
  /** Absolute path of the inbox file we wrote to. */
  inbox_path: string;
}

/**
 * Append a single inbound ChatMessage to the appropriate inbox.
 * Caller decides which (route via `routing.RoutingIndex` lookup before
 * calling). If projectUuid is provided, writes to that project's inbox;
 * otherwise to the orphan inbox.
 */
export async function appendToInbox(
  msg: ChatMessage,
  projectUuid: string | null,
  dataRoot?: string,
): Promise<AppendResult> {
  const destDir = projectUuid ? projectInboxDir(projectUuid, dataRoot) : orphanInboxDir(dataRoot);
  await fs.mkdir(destDir, { recursive: true });
  const inboxFile = path.join(destDir, `${msg.platform}.jsonl`);
  const line: InboxMessage = {
    v: 1,
    id: msg.id,
    platform: msg.platform,
    channel: msg.channel,
    sender: msg.sender,
    sender_id: msg.senderId,
    text: msg.text,
    received_at: msg.receivedAt.toISOString(),
    enqueued_at: new Date().toISOString(),
    mentions_bot: msg.mentionsBot,
  };
  // appendFile with utf8 uses O_APPEND under the hood; small writes
  // are POSIX-atomic. JSONL line ends with \n so consumers can split
  // safely even if a write straddles a buffer flush.
  await fs.appendFile(inboxFile, `${JSON.stringify(line)}\n`, "utf8");
  return projectUuid
    ? { destination: "project", project_uuid: projectUuid, inbox_path: inboxFile }
    : { destination: "orphan", inbox_path: inboxFile };
}

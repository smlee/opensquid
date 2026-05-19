/**
 * Read side of the per-project inbox (v0.7.1 Phase E).
 *
 * Daemon writes to ~/.opensquid/projects/<uuid>/inbox/<platform>.jsonl;
 * MCP servers (via the `chat_poll_inbox` tool) read here. Each line is
 * a self-contained `InboxMessage` (see inbox.ts for the schema).
 *
 * `pollInbox` reads the tail of the file. For v0.7.1 the implementation
 * is "read the whole file, take last N lines after `since`" — simple
 * and correct for our expected file sizes (a few KB per project per
 * day). Tail-with-offset can replace this when files routinely exceed
 * 1 MB.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { InboxMessage } from "./inbox.js";
import type { ChatPlatform } from "../gateway.js";
import { projectInboxDir } from "./routing.js";

export interface PollInboxParams {
  /** Project uuid whose inbox to read. */
  projectUuid: string;
  /** If set, only this platform; else all platforms with inbox files. */
  platform?: ChatPlatform;
  /** Cap on returned messages. Default 20. */
  limit?: number;
  /** Drop messages with `enqueued_at` ≤ this ISO timestamp. */
  since?: string;
  /** Override data root (tests). */
  dataRoot?: string;
}

export interface PollInboxResult {
  /** Messages in chronological order (oldest first). */
  messages: InboxMessage[];
  /** Platforms whose inbox files were scanned. */
  scanned_platforms: ChatPlatform[];
}

export async function pollInbox(params: PollInboxParams): Promise<PollInboxResult> {
  const limit = params.limit ?? 20;
  const dir = projectInboxDir(params.projectUuid, params.dataRoot);

  const platforms: ChatPlatform[] = params.platform
    ? [params.platform]
    : await listPlatformsWithInbox(dir);

  const all: InboxMessage[] = [];
  for (const p of platforms) {
    const file = path.join(dir, `${p}.jsonl`);
    try {
      const raw = await fs.readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          all.push(JSON.parse(line) as InboxMessage);
        } catch {
          // Skip malformed lines — daemon writes valid JSON only, but
          // a partial write under abnormal shutdown could leave one
          // bad line. Don't crash the poll over it.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }

  // Filter by `since`, then take the tail up to `limit`.
  const filtered = params.since ? all.filter((m) => m.enqueued_at > (params.since as string)) : all;
  // Sort by enqueued_at to give a consistent chronological order even
  // when multiple platforms interleave.
  filtered.sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
  const tail = filtered.slice(-limit);
  return { messages: tail, scanned_platforms: platforms };
}

async function listPlatformsWithInbox(dir: string): Promise<ChatPlatform[]> {
  try {
    const entries = await fs.readdir(dir);
    const out: ChatPlatform[] = [];
    for (const e of entries) {
      if (e === "telegram.jsonl") out.push("telegram");
      else if (e === "discord.jsonl") out.push("discord");
      else if (e === "slack.jsonl") out.push("slack");
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

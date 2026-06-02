/**
 * Umbrella chat-routing source + pure resolution FSM (CAT.1a).
 *
 * Replaces the legacy per-project `chat-routing.json` + the in-worker
 * `RoutingIndex` Map (`src.legacy/chat/daemon/routing.ts`) — see
 * `docs/research/T-chat-as-terminal-CAT1-pre-research-2026-06-02.md` (loop
 * repo) for the full design + the two-worlds finding.
 *
 * One authoritative source on disk: `~/.opensquid/channels.json`, keyed by
 * UMBRELLA (loop + loop-engine + opensquid = ONE umbrella, topic 15), not by
 * per-cwd project_uuid. This structurally enforces the locked invariants:
 *
 *   - Border (#3): one (chat_id, topic_id) ↔ exactly one umbrella row, so a
 *     message in a topic reaches only that umbrella's session.
 *   - Umbrella ≤1:1 (#4): resolution is at the umbrella level via `members`
 *     (cwd prefixes) — it eliminates the `da96≡0742` mirror hack entirely
 *     (one umbrella row covers every member cwd; nothing to keep in sync).
 *   - General (#5): DM + the supergroup General thread + the "All" topic
 *     resolve to the reserved `'general'` id (the project-less session),
 *     never a project umbrella.
 *
 * Resolution is three PURE TOTAL functions — the deterministic routing the
 * track demands (the agent never picks a raw channel/tool; the FSM derives
 * the destination). No I/O in the resolvers; `loadChannelsConfig` is the only
 * disk read and is ENOENT/parse-tolerant (absent ⇒ null, never throws).
 *
 * Imports from: zod, node:fs/promises, ../runtime/paths.
 * Imported by: CAT.1b daemon (inbound routing), CAT.1c readers + MCP, tests.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { OPENSQUID_HOME } from '../runtime/paths.js';

// ---------------------------------------------------------------------------
// Reserved id for the project-less "general" session (invariant #5). Not a
// legal umbrella `id` — the schema forbids an umbrella row from claiming it.
// ---------------------------------------------------------------------------

export const GENERAL_UMBRELLA = 'general' as const;
/**
 * A resolved chat target: either an umbrella `id` or the reserved
 * `GENERAL_UMBRELLA` sentinel. Both are strings — the union would collapse
 * to `string`, so we model it as `string` and rely on `GENERAL_UMBRELLA` for
 * the sentinel comparison rather than a (redundant) literal-union type.
 */
export type UmbrellaTarget = string;

// ---------------------------------------------------------------------------
// Schema — `~/.opensquid/channels.json`, v1.
//
// `.strict()` everywhere (matches `src/runtime/chat/inbox.ts`): an unknown key
// is a config bug we want surfaced, not silently ignored.
// ---------------------------------------------------------------------------

const TelegramTarget = z
  .object({
    /** Supergroup/chat id (negative string for supergroups). */
    chat_id: z.string().min(1),
    /** Forum topic id; omitted ⇒ the umbrella owns the bare-group key. */
    topic_id: z.number().int().optional(),
  })
  .strict();
export type TelegramTarget = z.infer<typeof TelegramTarget>;

const UmbrellaRow = z
  .object({
    /** Stable umbrella id (e.g. `loop`). MUST NOT be the reserved `general`. */
    id: z.string().min(1).refine((s) => s !== GENERAL_UMBRELLA, {
      message: `umbrella id must not be the reserved "${GENERAL_UMBRELLA}"`,
    }),
    /** Absolute cwd prefixes that belong to this umbrella (cwd→umbrella). */
    members: z.array(z.string().min(1)),
    telegram: TelegramTarget.optional(),
  })
  .strict();
export type UmbrellaRow = z.infer<typeof UmbrellaRow>;

const GeneralRow = z
  .object({
    telegram: z
      .object({
        chat_id: z.string().min(1),
        /** DM sender ids that route to the general session (invariant #5). */
        dm_user_ids: z.array(z.string().min(1)).optional(),
        /** When true, the bare-group (General thread / "All") routes here. */
        owns_general_thread: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GeneralRow = z.infer<typeof GeneralRow>;

/**
 * Who answers chat for the live umbrellas:
 *   - `session` (default) — chat MIRRORS the live MCP session: when a Claude
 *     Code session is open for the umbrella it claims the lease + its Stop-hook
 *     drive answers (in whatever mode that session runs — e.g. subscription).
 *   - `headless` — the live session does NOT claim the lease; the dedicated
 *     headless agent-bridge answers instead (even with no terminal open).
 * Changeable in `channels.json` per the "I should be able to change on
 * configuration" requirement; absent ⇒ `session`.
 */
export const ResponderMode = z.enum(['session', 'headless']);
export type ResponderMode = z.infer<typeof ResponderMode>;

export const ChannelsConfig = z
  .object({
    v: z.literal(1),
    umbrellas: z.array(UmbrellaRow),
    general: GeneralRow.optional(),
    responder: ResponderMode.optional(),
  })
  .strict();
export type ChannelsConfig = z.infer<typeof ChannelsConfig>;

/** On-disk path for the single authoritative routing source. */
export const channelsConfigPath = (): string => join(OPENSQUID_HOME(), 'channels.json');

/**
 * Load + validate `~/.opensquid/channels.json`. ENOENT, malformed JSON, or a
 * schema-invalid file all return null — a broken/absent config must never
 * crash the daemon (it degrades to "everything orphans"), matching the
 * fail-quiet posture of the legacy loader + `readInbox`.
 */
export async function loadChannelsConfig(): Promise<ChannelsConfig | null> {
  let raw: string;
  try {
    raw = await readFile(channelsConfigPath(), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const safe = ChannelsConfig.safeParse(parsed);
  return safe.success ? safe.data : null;
}

// ---------------------------------------------------------------------------
// Pure resolution FSM. No I/O — the caller loads the config once and threads
// it in. Every function is total: it returns a value (or null) for every
// input, never throws.
// ---------------------------------------------------------------------------

/** Telegram fields a resolver needs from a normalized inbound message. */
export interface InboundTelegramKey {
  platform: 'telegram';
  /** Supergroup/chat id as a string. */
  chatId: string;
  /** Forum topic id, if the message carried one. */
  topicId?: number;
  /** Sender's user id (for DM resolution). */
  senderId: string;
  /** True iff this is a private chat (Telegram: `chat.id === from.id`). */
  direct: boolean;
}

/**
 * Resolve an inbound Telegram message to its umbrella (or the general
 * session, or null = orphan). Order of specificity:
 *
 *   1. DM (`direct`) whose sender is in `general.telegram.dm_user_ids`
 *      → `'general'` (#5). A DM never routes to a project umbrella.
 *   2. Supergroup + topic exactly matching one umbrella's
 *      `(chat_id, topic_id)` → that umbrella (#3, one topic ↔ one umbrella).
 *   3. Supergroup with no topic (or matching the general chat) when
 *      `general.telegram.owns_general_thread` → `'general'` (General/All).
 *   4. No match → null (orphan inbox).
 *
 * Deterministic: the (chat_id, topic_id) → umbrella map is a structural
 * 1:1, so there is no "later wins" collision to resolve at runtime.
 */
export function resolveInboundUmbrella(
  cfg: ChannelsConfig,
  key: InboundTelegramKey,
): UmbrellaTarget | null {
  const general = cfg.general?.telegram;

  // 1. DM → general (only when the sender is allowlisted).
  if (key.direct) {
    if (general?.dm_user_ids?.includes(key.senderId) === true) return GENERAL_UMBRELLA;
    return null;
  }

  // 2. Supergroup + topic → the umbrella owning exactly that (chat, topic).
  if (key.topicId !== undefined) {
    for (const u of cfg.umbrellas) {
      if (u.telegram?.chat_id === key.chatId && u.telegram.topic_id === key.topicId) {
        return u.id;
      }
    }
  } else {
    // No topic: an umbrella may own the bare-group key (topic_id unset).
    for (const u of cfg.umbrellas) {
      if (u.telegram?.chat_id === key.chatId && u.telegram.topic_id === undefined) {
        return u.id;
      }
    }
  }

  // 3. General thread / "All" in the general chat → general.
  if (
    general?.owns_general_thread === true &&
    general.chat_id === key.chatId &&
    key.topicId === undefined
  ) {
    return GENERAL_UMBRELLA;
  }

  // 4. Orphan.
  return null;
}

/**
 * Resolve an umbrella (or general) → its outbound Telegram target (reply-to-
 * source). The agent never chooses a channel; CAT.3 derives the destination
 * from the umbrella the turn belongs to. Returns null when the target has no
 * telegram binding (caller drops or falls back).
 */
export function resolveOutbound(
  cfg: ChannelsConfig,
  target: UmbrellaTarget,
): TelegramTarget | null {
  if (target === GENERAL_UMBRELLA) {
    const tg = cfg.general?.telegram;
    return tg !== undefined ? { chat_id: tg.chat_id } : null;
  }
  const u = cfg.umbrellas.find((x) => x.id === target);
  return u?.telegram ?? null;
}

/**
 * Resolve a session's cwd → its umbrella id (or general). Longest-prefix
 * match over every umbrella's `members`, so a nested member cwd wins over a
 * shorter sibling. Returns null when no umbrella claims the cwd (the session
 * has no chat binding). Replaces per-cwd `resolveProjectUuid` for chat.
 */
export function resolveUmbrellaForCwd(cfg: ChannelsConfig, cwd: string): UmbrellaTarget | null {
  let best: { id: string; len: number } | null = null;
  for (const u of cfg.umbrellas) {
    for (const member of u.members) {
      if ((cwd === member || cwd.startsWith(`${member}/`)) && (best === null || member.length > best.len)) {
        best = { id: u.id, len: member.length };
      }
    }
  }
  return best?.id ?? null;
}

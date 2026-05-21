/**
 * Startup health checks for chat-daemon's configured inbound channels
 * (v0.5.89 / TG.2).
 *
 * Why this exists: the daemon's inbound path silently accepts whatever
 * Telegram delivers via long-poll. If the bot has been kicked from a
 * supergroup, or the supergroup_id in chat-routing.json is stale, or
 * the bot doesn't have read permission, the symptom is identical:
 * "no inbound messages from that chat ever arrive". The daemon log
 * looks healthy. The user assumes their routing is broken.
 *
 * This module adds one round-trip per unique inbound chat_id at
 * daemon startup, calling Telegram's `getChat` HTTPS endpoint, and
 * logs a clear reachability verdict per chat_id. Catches:
 *
 *   - 403 Forbidden ("bot was kicked from the supergroup chat") — the
 *     load-bearing case this module was written to catch.
 *   - 400 Bad Request (chat_id doesn't exist or bot can't see it) —
 *     surfaces typo'd or stale chat_ids.
 *   - Network failures — distinguishes config error from connectivity
 *     issues.
 *
 * Scope discipline:
 *   - Telegram-only. Discord + Slack health checks deferred (their
 *     SDKs require different shapes; one-platform-at-a-time).
 *   - Best-effort. Health-check failures DO NOT block daemon startup;
 *     they log warnings and let the daemon continue. A bot that's
 *     kicked from one chat may still be fine for outbound to others.
 *   - No grammy dependency. Uses native fetch so this module can run
 *     even if grammy isn't loaded yet (it's a dynamic import elsewhere).
 *
 * Imports from: nothing (fetch is global in Node 20+).
 * Imported by: src.legacy/chat/daemon/worker.ts (post-gateway-start).
 */

export interface ChatReachability {
  /** The chat_id we tested, in raw string form (e.g. `-1001234567890` for a supergroup). */
  chatId: string;
  /** True iff Telegram returned `ok: true` on getChat. */
  ok: boolean;
  /** Chat title when known (supergroups + channels carry it). */
  title?: string;
  /** Chat type when known (`supergroup`, `group`, `channel`, `private`). */
  chatType?: string;
  /** Telegram error_code when not ok (typically 403 or 400). */
  errorCode?: number;
  /** Telegram description string when not ok. */
  errorDescription?: string;
  /** Set when the round-trip itself failed (DNS, TLS, timeout). */
  networkError?: string;
}

interface TelegramGetChatResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
  result?: {
    id: number;
    type: string;
    title?: string;
  };
}

/**
 * Call Telegram getChat for each chat_id and return per-chat
 * reachability. Sequential because the call count is small (typically
 * 1–3 chats per project, 1–10 projects per host) and Telegram's bot
 * API rate limits favor sequential calls over bursts. Per-call
 * timeout is 5s — enough for legitimate latency, short enough that
 * a hung API doesn't block daemon startup forever.
 *
 * `botToken` is the loaded Telegram bot token. If absent or empty,
 * returns an empty array (no point health-checking without a token).
 */
export async function verifyTelegramChats(
  botToken: string | undefined,
  chatIds: readonly string[],
): Promise<ChatReachability[]> {
  if (!botToken || botToken.trim().length === 0) return [];
  if (chatIds.length === 0) return [];

  const unique = Array.from(new Set(chatIds));
  const results: ChatReachability[] = [];
  for (const chatId of unique) {
    results.push(await checkOne(botToken, chatId));
  }
  return results;
}

async function checkOne(token: string, chatId: string): Promise<ChatReachability> {
  // 5s timeout via AbortController — keeps a hung Telegram API from
  // wedging daemon startup indefinitely. The daemon doesn't actually
  // need health-check results to be useful; if all calls time out, we
  // just log "skipped due to timeouts" and continue.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const url = `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`;
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const body = (await res.json()) as TelegramGetChatResponse;
    if (body.ok && body.result) {
      const r: ChatReachability = { chatId, ok: true, chatType: body.result.type };
      if (body.result.title) r.title = body.result.title;
      return r;
    }
    const r: ChatReachability = { chatId, ok: false };
    if (body.error_code !== undefined) r.errorCode = body.error_code;
    if (body.description) r.errorDescription = body.description;
    return r;
  } catch (err) {
    return {
      chatId,
      ok: false,
      networkError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render a single reachability verdict as a one-line log message.
 * Stays formatting-stable so operators can grep daemon logs for
 * `[chat-daemon] chat-reachability` to find all verdicts in one pass.
 */
export function formatReachabilityLine(r: ChatReachability): string {
  if (r.ok) {
    const title = r.title ? ` "${r.title}"` : "";
    const type = r.chatType ? ` (${r.chatType})` : "";
    return `[chat-daemon] chat-reachability ${r.chatId}${title}${type}: OK`;
  }
  if (r.networkError) {
    return `[chat-daemon] chat-reachability ${r.chatId}: NETWORK_ERROR ${r.networkError}`;
  }
  // Common 403 = "Forbidden: bot was kicked from the supergroup chat"
  // Common 400 = "Bad Request: chat not found" (typo'd or stale id)
  const code = r.errorCode !== undefined ? `${r.errorCode}` : "?";
  const desc = r.errorDescription ?? "(no description)";
  return `[chat-daemon] chat-reachability ${r.chatId}: ERROR ${code} ${desc}`;
}

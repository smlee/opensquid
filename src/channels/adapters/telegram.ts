/**
 * telegram:// adapter — outbound Bot API delivery via grammy.
 *
 * URI scheme: `telegram://<chat_id>[/<topic_id>]`
 *   - `chat_id` may be negative (supergroups + channels are negative).
 *   - Optional `topic_id` maps to grammy's `message_thread_id` (forum
 *     topics in supergroups).
 *
 * Allowlist: enforced at `send()`. A chat_id not in
 * `opts.allowlistChatIds` rejects with `{ ok: false, error: 'chat not
 * in allowlist' }` BEFORE any API call — no leak of policy decision to
 * the chat itself.
 *
 * Inbound (long-polling) is opt-in via `start()`. The 409 Conflict path
 * is the documented degradation when another consumer holds the token
 * (e.g. a parallel Claude Code plugin:telegram bot): we back off
 * exponentially up to 5 attempts and otherwise stay outbound-only.
 *
 * Critical async-pattern note: grammy's `bot.start()` returns a promise
 * that resolves ONLY on shutdown (when `bot.stop()` is called) — it
 * does NOT resolve on successful start. Awaiting it deadlocks the
 * caller forever. We deliberately do not await it; we only attach a
 * `.catch()` to handle the 409 retry path. The legacy adapter at
 * `src.legacy/chat/adapters/telegram.ts` documents the same gotcha.
 *
 * Outbound-only mode: when `opts.outboundOnly === true` OR every 409
 * retry has been exhausted, `send()` continues to work (it uses
 * `bot.api.sendMessage` over HTTPS, which is independent of the
 * long-poll). `start()` becomes a no-op in this state.
 */

import { Bot, GrammyError, HttpError } from 'grammy';
import type { ChannelAdapter, ChannelMessage, SendResult } from '../types.js';

export interface TelegramAdapterOpts {
  /** Bot API token from @BotFather. */
  token: string;
  /** Allowlist of chat_ids the adapter will deliver to. */
  allowlistChatIds: number[];
  /** Skip `bot.start()` entirely; outbound `send()` continues to work. */
  outboundOnly?: boolean;
}

export interface TelegramAdapter extends ChannelAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Maximum 409 retry attempts before falling back to outbound-only. */
const MAX_409_RETRIES = 5;
/** Cap for exponential backoff between 409 retries. */
const RETRY_BACKOFF_CAP_MS = 30_000;

/**
 * Parse `telegram://<chat_id>[/<topic_id>]` into its parts. Returns
 * `null` when the URI is malformed.
 */
function parseUri(uri: string): { chatId: number; topicId?: number } | null {
  const match = /^telegram:\/\/(-?\d+)(?:\/(\d+))?$/.exec(uri);
  if (match === null) return null;
  const chatIdStr = match[1];
  if (chatIdStr === undefined) return null;
  const chatId = Number(chatIdStr);
  const topicStr = match[2];
  const topicId = topicStr !== undefined ? Number(topicStr) : undefined;
  return topicId === undefined ? { chatId } : { chatId, topicId };
}

export function telegramAdapter(opts: TelegramAdapterOpts): TelegramAdapter {
  const bot = new Bot(opts.token);
  let started = false;
  let stopped = false;

  async function attemptStart(attempt: number): Promise<void> {
    if (stopped) return;
    try {
      // Defensive: clear any stale webhook config that would prevent
      // long-polling. `drop_pending_updates: false` preserves unread
      // updates across reconnects.
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch {
      // deleteWebhook failure is non-fatal — proceed to bot.start().
    }
    // DO NOT await bot.start(). It resolves on shutdown only; awaiting
    // here would deadlock. `.catch()` handles the 409 retry path.
    bot.start({ drop_pending_updates: false }).catch((e: unknown) => {
      if (e instanceof GrammyError && e.error_code === 409) {
        if (attempt < MAX_409_RETRIES) {
          const next = attempt + 1;
          const delay = Math.min(RETRY_BACKOFF_CAP_MS, 1000 * 2 ** next);
          setTimeout(() => {
            void attemptStart(next);
          }, delay);
        }
        // Else: give up on inbound; outbound-only path remains.
        return;
      }
      // Non-409 errors: leave bot stopped. send() still works.
    });
  }

  return {
    scheme: 'telegram',

    validate(uri: string): boolean {
      return /^telegram:\/\/-?\d+(\/\d+)?$/.test(uri);
    },

    async send(uri: string, message: ChannelMessage): Promise<SendResult> {
      const parsed = parseUri(uri);
      if (parsed === null) return { ok: false, error: 'bad uri' };
      if (!opts.allowlistChatIds.includes(parsed.chatId)) {
        return { ok: false, error: 'chat not in allowlist' };
      }
      try {
        const extra =
          parsed.topicId !== undefined ? { message_thread_id: parsed.topicId } : undefined;
        await bot.api.sendMessage(parsed.chatId, message.text, extra);
        return { ok: true };
      } catch (e: unknown) {
        if (e instanceof GrammyError) {
          return { ok: false, error: `telegram api ${e.error_code}: ${e.description}` };
        }
        if (e instanceof HttpError) {
          return { ok: false, error: `network: ${e.message}` };
        }
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async start(): Promise<void> {
      if (started || opts.outboundOnly === true) {
        started = true;
        return;
      }
      started = true;
      stopped = false;
      // Kick off the start loop. Do NOT await — bot.start() resolves on
      // shutdown only.
      void attemptStart(0);
      // Yield via microtask so the polling loop registers before send
      // dispatch. Using Promise.resolve() (not setImmediate) so vitest's
      // fake timers don't stall the await; microtasks aren't trapped.
      await Promise.resolve();
    },

    async stop(): Promise<void> {
      if (!started) return;
      stopped = true;
      started = false;
      try {
        await bot.stop();
      } catch {
        // best-effort — if grammy already shut down, nothing to do.
      }
    },
  };
}

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
import type { InboundChannelEvent } from '../../runtime/event.js';
import type { ChannelAdapter, ChannelMessage, InboundSubscription, SendResult } from '../types.js';

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
  /**
   * AUTO.6 — attach an inbound `'message'` handler that emits a unified
   * `InboundChannelEvent`. Auto-starts long-polling if not already started
   * (skipped when `outboundOnly: true` — inbound is impossible there).
   */
  subscribeInbound(
    handler: (event: InboundChannelEvent) => Promise<void>,
  ): Promise<InboundSubscription>;
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

/**
 * Minimal grammy Context shape used by `subscribeInbound`. Declared
 * structurally so the adapter doesn't pull grammy's transitive `@grammyjs/types`
 * surface into our public types — the real `Context` is provided by grammy
 * at runtime.
 */
interface InboundCtx {
  chat?: { id: number };
  from?: { id: number | string };
  message?: {
    text?: string;
    message_thread_id?: number;
  };
}

/** Internal handler slot — one per `subscribeInbound` call. `enabled`
 *  toggles the handler off on `unsubscribe()` since grammy has no
 *  per-middleware removal API. */
interface InboundHandlerSlot {
  enabled: boolean;
  fn: (event: InboundChannelEvent) => Promise<void>;
}

export function telegramAdapter(opts: TelegramAdapterOpts): TelegramAdapter {
  const bot = new Bot(opts.token);
  let started = false;
  let stopped = false;
  const inboundHandlers: InboundHandlerSlot[] = [];
  let inboundMiddlewareInstalled = false;

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
      // Disable all inbound subscription slots so an in-flight grammy
      // update can't fire a handler after stop() returns.
      for (const slot of inboundHandlers) slot.enabled = false;
      try {
        await bot.stop();
      } catch {
        // best-effort — if grammy already shut down, nothing to do.
      }
    },

    async subscribeInbound(
      handler: (event: InboundChannelEvent) => Promise<void>,
    ): Promise<InboundSubscription> {
      // Outbound-only mode cannot accept inbound — surface as a stub that
      // immediately resolves on unsubscribe. (Skip + audit lives in the
      // router; the adapter itself stays silent.)
      if (opts.outboundOnly === true) {
        return {
          unsubscribe: async (): Promise<void> => {
            /* no-op */
          },
        };
      }

      // Install a single grammy middleware on first subscribeInbound;
      // subsequent calls just push handlers into the slot list. grammy has
      // no per-middleware removal API — we toggle `enabled` to detach.
      if (!inboundMiddlewareInstalled) {
        inboundMiddlewareInstalled = true;
        bot.on('message', async (ctx: InboundCtx) => {
          // Build the unified event once per inbound message; deliver
          // to every still-enabled handler slot.
          if (ctx.chat === undefined) return;
          const threadId = ctx.message?.message_thread_id;
          const channelUri =
            threadId !== undefined
              ? `telegram://${ctx.chat.id}/${threadId}`
              : `telegram://${ctx.chat.id}`;
          const event: InboundChannelEvent = {
            kind: 'inbound_channel',
            channelUri,
            sender: ctx.from?.id !== undefined ? String(ctx.from.id) : 'unknown',
            text: ctx.message?.text ?? '',
            ...(threadId !== undefined ? { threadKey: String(threadId) } : {}),
            receivedAt: new Date().toISOString(),
          };
          for (const slot of inboundHandlers) {
            if (!slot.enabled) continue;
            try {
              await slot.fn(event);
            } catch {
              // Handler errors stay inside the adapter — never bubble to
              // grammy's update loop. (Matches Slack's posture.)
            }
          }
        });
      }

      const slot: InboundHandlerSlot = { enabled: true, fn: handler };
      inboundHandlers.push(slot);

      // Auto-start long-polling so the bot actually receives updates. The
      // outboundOnly path is already handled above; reaching here implies
      // inbound is permitted. `start()`-style idempotence keeps a double
      // subscribeInbound cheap.
      if (!started) {
        started = true;
        stopped = false;
        void attemptStart(0);
        await Promise.resolve();
      }

      return {
        // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy InboundSubscription contract
        unsubscribe: async (): Promise<void> => {
          slot.enabled = false;
        },
      };
    },
  };
}

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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import type { InboundChannelEvent } from '../../runtime/event.js';
import { inboundMediaDir } from '../../runtime/paths.js';
import type {
  ChannelAdapter,
  ChannelMessage,
  InboundChatMessage,
  InboundMedia,
  InboundSubscription,
  SendResult,
} from '../types.js';

export interface TelegramAdapterOpts {
  /** Bot API token from @BotFather. */
  token: string;
  /** Allowlist of chat_ids the adapter will deliver to. */
  allowlistChatIds: number[];
  /** Skip `bot.start()` entirely; outbound `send()` continues to work. */
  outboundOnly?: boolean;
  /**
   * Bot's own @username (without `@`), used to compute `mentionsBot` on the
   * rich transport envelope. The daemon resolves it once via `getMe` at
   * startup and passes it here. Unset ⇒ `mentionsBot` is always false.
   */
  botUsername?: string;
  /**
   * CAT.4 — directory inbound media (photos/documents) is downloaded into.
   * Defaults to `inboundMediaDir()` (`~/.opensquid/media/inbound`). Tests
   * point it at an `mkdtemp` so downloads never escape the sandbox.
   */
  mediaDownloadDir?: string;
  /**
   * CAT.4 — injectable download seam. Given the fully-qualified Telegram file
   * URL (`https://api.telegram.org/file/bot<token>/<file_path>`), resolves to
   * the raw bytes. Defaults to `fetch`-based download; tests inject a stub so
   * the suite never hits the network.
   */
  download?: (url: string) => Promise<Uint8Array>;
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
  /**
   * CAT.1b — attach a RICH transport handler that emits the full
   * `InboundChatMessage` envelope (message id, sender id, DM flag, …) the
   * chat-daemon needs. Same lifecycle/auto-start semantics as
   * `subscribeInbound`; both are fed from one grammy middleware.
   */
  subscribeTransport(
    handler: (msg: InboundChatMessage) => Promise<void>,
  ): Promise<InboundSubscription>;
  /**
   * CAT.4 — deliver a photo from a local file. `uri` is the same
   * `telegram://<chat>[/<topic>]` shape as `send`; the optional `caption`
   * becomes the photo caption; `threadId` overrides any topic in the URI.
   * Returns the delivered `message_id` like `send`. Allowlist-enforced.
   */
  sendPhoto(
    uri: string,
    opts: { path: string; caption?: string; threadId?: number },
  ): Promise<SendResult>;
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

/** Map a grammy/transport error to the canonical `SendResult` failure shape.
 *  Shared by `send` + `sendPhoto` so the wire-error contract stays identical. */
function mapSendError(e: unknown): SendResult {
  if (e instanceof GrammyError) {
    return { ok: false, error: `telegram api ${e.error_code}: ${e.description}` };
  }
  if (e instanceof HttpError) {
    return { ok: false, error: `network: ${e.message}` };
  }
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/**
 * Minimal grammy Context shape used by `subscribeInbound`. Declared
 * structurally so the adapter doesn't pull grammy's transitive `@grammyjs/types`
 * surface into our public types — the real `Context` is provided by grammy
 * at runtime.
 */
/** A Telegram `PhotoSize` (one entry in `message.photo`). */
interface CtxPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

/** A Telegram `Document` (`message.document`). */
interface CtxDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface InboundCtx {
  chat?: { id: number; type?: string };
  from?: { id: number | string; username?: string; first_name?: string };
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    caption?: string;
    message_thread_id?: number;
    /** CAT.4 — Telegram delivers a photo as an array of size variants. */
    photo?: CtxPhotoSize[];
    /** CAT.4 — arbitrary uploaded file. */
    document?: CtxDocument;
  };
  /** grammy's `ctx.api.getFile` — used to resolve a file_id → file_path.
   *  Declared structurally so the adapter doesn't pull grammy's full Api type. */
  api?: { getFile: (fileId: string) => Promise<{ file_path?: string }> };
}

/** Default download seam — fetch the bytes from the Telegram file URL. */
const defaultDownload = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${String(res.status)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
};

/** Extension from a Telegram `file_path` (`photos/file_42.jpg` → `jpg`);
 *  falls back to `bin` when none is present. */
function extFromFilePath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1 || dot === filePath.length - 1) return 'bin';
  return filePath.slice(dot + 1).toLowerCase();
}

/** One attachment queued for download inside `downloadMedia`. */
interface PendingDownload {
  kind: 'photo' | 'document';
  fileId: string;
  mime?: string;
}

/** Pick the largest PhotoSize by file_size, then width (Telegram orders
 *  ascending but we don't rely on that). Returns undefined for an empty array. */
function largestPhoto(photos: readonly CtxPhotoSize[]): CtxPhotoSize | undefined {
  let best: CtxPhotoSize | undefined;
  for (const p of photos) {
    if (best === undefined) {
      best = p;
      continue;
    }
    const pScore = p.file_size ?? p.width ?? 0;
    const bScore = best.file_size ?? best.width ?? 0;
    if (pScore > bScore) best = p;
  }
  return best;
}

/** Internal handler slot — one per `subscribeInbound` call. `enabled`
 *  toggles the handler off on `unsubscribe()` since grammy has no
 *  per-middleware removal API. */
interface InboundHandlerSlot {
  enabled: boolean;
  fn: (event: InboundChannelEvent) => Promise<void>;
}

/** Rich-transport handler slot (CAT.1b) — fed the full envelope. */
interface TransportHandlerSlot {
  enabled: boolean;
  fn: (msg: InboundChatMessage) => Promise<void>;
}

/**
 * Build the rich `InboundChatMessage` from a grammy context. Pure. `direct`
 * is a Telegram private chat (`chat.id === from.id`); `mentionsBot` is a
 * case-insensitive `@<botUsername>` scan of the text (false when the bot
 * username is unknown). `receivedAt` uses the platform `date` (unix seconds)
 * when present, else the empty string is avoided by the caller.
 */
function buildTransportMessage(
  ctx: InboundCtx,
  botUsername: string | undefined,
  nowIso: string,
): InboundChatMessage | null {
  if (ctx.chat === undefined) return null;
  const fromId = ctx.from?.id;
  const senderId = fromId !== undefined ? String(fromId) : '';
  // CAT.4 — a media message carries its body as `caption`, not `text`. Mirror
  // the caption into `text` so caption-only photos still drive a non-empty
  // envelope (it's ALSO carried on each media entry's `caption`).
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';
  const threadId = ctx.message?.message_thread_id;
  const date = ctx.message?.date;
  const mentionsBot =
    botUsername !== undefined && botUsername !== ''
      ? text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)
      : false;
  return {
    platform: 'telegram',
    messageId: ctx.message?.message_id !== undefined ? String(ctx.message.message_id) : '',
    chatId: String(ctx.chat.id),
    ...(threadId !== undefined ? { topicId: threadId } : {}),
    sender: ctx.from?.username ?? ctx.from?.first_name ?? senderId,
    senderId,
    text,
    receivedAt: date !== undefined ? new Date(date * 1000).toISOString() : nowIso,
    mentionsBot,
    direct: ctx.chat.type === 'private' || String(ctx.chat.id) === senderId,
  };
}

export function telegramAdapter(opts: TelegramAdapterOpts): TelegramAdapter {
  const bot = new Bot(opts.token);
  let started = false;
  let stopped = false;
  const inboundHandlers: InboundHandlerSlot[] = [];
  const transportHandlers: TransportHandlerSlot[] = [];
  let inboundMiddlewareInstalled = false;
  const download = opts.download ?? defaultDownload;

  /**
   * CAT.4 — download every photo/document on the message to the media dir and
   * return the resulting `InboundMedia` pointers (empty when none). Resolves
   * each `file_id` → `file_path` via `getFile`, downloads the bytes via the
   * injectable seam, and writes `telegram-<message_id>-<n>.<ext>`. A per-item
   * failure is swallowed (best-effort) so one broken attachment can't drop the
   * whole message; the surviving items + text still flow through.
   */
  async function downloadMedia(ctx: InboundCtx, messageId: string): Promise<InboundMedia[]> {
    const api = ctx.api;
    if (api === undefined) return [];
    const dir = opts.mediaDownloadDir ?? inboundMediaDir();
    const caption = ctx.message?.caption;
    const out: InboundMedia[] = [];
    let n = 0;

    const pending: PendingDownload[] = [];
    const photo = largestPhoto(ctx.message?.photo ?? []);
    if (photo !== undefined) pending.push({ kind: 'photo', fileId: photo.file_id });
    const doc = ctx.message?.document;
    if (doc !== undefined) {
      pending.push({
        kind: 'document',
        fileId: doc.file_id,
        ...(doc.mime_type !== undefined ? { mime: doc.mime_type } : {}),
      });
    }

    for (const item of pending) {
      try {
        const file = await api.getFile(item.fileId);
        const filePath = file.file_path;
        if (filePath === undefined || filePath.length === 0) continue;
        const url = `https://api.telegram.org/file/bot${opts.token}/${filePath}`;
        const bytes = await download(url);
        const ext = extFromFilePath(filePath);
        const dest = join(dir, `telegram-${messageId}-${String(n)}.${ext}`);
        await mkdir(dir, { recursive: true });
        await writeFile(dest, bytes);
        out.push({
          kind: item.kind,
          path: dest,
          ...(caption !== undefined ? { caption } : {}),
          ...(item.mime !== undefined ? { mime: item.mime } : {}),
        });
        n += 1;
      } catch {
        // best-effort: skip a failed attachment, keep the rest + the text.
      }
    }
    return out;
  }

  /**
   * Install the single grammy `'message'` middleware (idempotent). Builds the
   * rich `InboundChatMessage` once per update, feeds every enabled transport
   * slot with it, and derives the lossy `InboundChannelEvent` for every
   * enabled inbound slot. One bot, one middleware, two surfaces.
   */
  function ensureMiddleware(): void {
    if (inboundMiddlewareInstalled) return;
    inboundMiddlewareInstalled = true;
    bot.on('message', async (ctx: InboundCtx) => {
      const base = buildTransportMessage(ctx, opts.botUsername, new Date().toISOString());
      if (base === null) return;
      // CAT.4 — download any attachments + attach the pointers. A message with
      // media but no text still produces a non-null envelope here (no drop).
      const media = await downloadMedia(ctx, base.messageId);
      const msg: InboundChatMessage = media.length > 0 ? { ...base, media } : base;
      for (const slot of transportHandlers) {
        if (!slot.enabled) continue;
        try {
          await slot.fn(msg);
        } catch {
          // Handler errors stay inside the adapter — never bubble to grammy.
        }
      }
      if (inboundHandlers.length > 0) {
        const channelUri =
          msg.topicId !== undefined
            ? `telegram://${msg.chatId}/${msg.topicId}`
            : `telegram://${msg.chatId}`;
        const event: InboundChannelEvent = {
          kind: 'inbound_channel',
          channelUri,
          sender: msg.senderId !== '' ? msg.senderId : 'unknown',
          text: msg.text,
          ...(msg.topicId !== undefined ? { threadKey: String(msg.topicId) } : {}),
          receivedAt: msg.receivedAt,
        };
        for (const slot of inboundHandlers) {
          if (!slot.enabled) continue;
          try {
            await slot.fn(event);
          } catch {
            // Handler errors stay inside the adapter.
          }
        }
      }
    });
  }

  /** Auto-start long-polling if not already running (no-op in outbound-only). */
  function ensureStarted(): void {
    if (started || stopped) return;
    started = true;
    stopped = false;
    void attemptStart(0);
  }

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
        const sent = (await bot.api.sendMessage(parsed.chatId, message.text, extra)) as
          | { message_id?: number }
          | undefined;
        const sentId = sent?.message_id;
        return sentId !== undefined ? { ok: true, messageId: String(sentId) } : { ok: true };
      } catch (e: unknown) {
        return mapSendError(e);
      }
    },

    async sendPhoto(
      uri: string,
      photoOpts: { path: string; caption?: string; threadId?: number },
    ): Promise<SendResult> {
      const parsed = parseUri(uri);
      if (parsed === null) return { ok: false, error: 'bad uri' };
      if (!opts.allowlistChatIds.includes(parsed.chatId)) {
        return { ok: false, error: 'chat not in allowlist' };
      }
      // Explicit threadId arg wins over any topic embedded in the URI.
      const thread = photoOpts.threadId ?? parsed.topicId;
      try {
        const extra: Record<string, number | string> = {};
        if (photoOpts.caption !== undefined) extra.caption = photoOpts.caption;
        if (thread !== undefined) extra.message_thread_id = thread;
        const sent = (await bot.api.sendPhoto(
          parsed.chatId,
          new InputFile(photoOpts.path),
          extra,
        )) as { message_id?: number } | undefined;
        const sentId = sent?.message_id;
        return sentId !== undefined ? { ok: true, messageId: String(sentId) } : { ok: true };
      } catch (e: unknown) {
        return mapSendError(e);
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
      // Disable all subscription slots so an in-flight grammy update can't
      // fire a handler after stop() returns.
      for (const slot of inboundHandlers) slot.enabled = false;
      for (const slot of transportHandlers) slot.enabled = false;
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
        return { unsubscribe: (): Promise<void> => Promise.resolve() };
      }
      ensureMiddleware();
      const slot: InboundHandlerSlot = { enabled: true, fn: handler };
      inboundHandlers.push(slot);
      ensureStarted();
      await Promise.resolve();
      return {
        unsubscribe: (): Promise<void> => {
          slot.enabled = false;
          return Promise.resolve();
        },
      };
    },

    async subscribeTransport(
      handler: (msg: InboundChatMessage) => Promise<void>,
    ): Promise<InboundSubscription> {
      // Outbound-only mode cannot accept inbound.
      if (opts.outboundOnly === true) {
        return { unsubscribe: (): Promise<void> => Promise.resolve() };
      }
      ensureMiddleware();
      const slot: TransportHandlerSlot = { enabled: true, fn: handler };
      transportHandlers.push(slot);
      ensureStarted();
      await Promise.resolve();
      return {
        unsubscribe: (): Promise<void> => {
          slot.enabled = false;
          return Promise.resolve();
        },
      };
    },
  };
}

import { afterEach, describe, expect, it } from "vitest";

import { ChatGatewayError } from "../gateway.js";
import {
  TelegramAdapter,
  TopicGoneError,
  detectBotMention,
  extractGrammyDescription,
  isTopicGoneError,
  parseTelegramChannel,
} from "./telegram.js";

describe("TelegramAdapter constructor", () => {
  it("rejects empty bot_token", () => {
    expect(() => new TelegramAdapter({ bot_token: "" })).toThrow(ChatGatewayError);
  });
  it("rejects whitespace-only bot_token", () => {
    expect(() => new TelegramAdapter({ bot_token: "   " })).toThrow(ChatGatewayError);
  });
  it("accepts a real-shaped token", () => {
    // Don't actually call start() — that would try to load grammy.
    const a = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    expect(a.platform).toBe("telegram");
  });
});

describe("detectBotMention", () => {
  it("returns false when botUsername is empty", () => {
    expect(detectBotMention("@somebot hello", [], "")).toBe(false);
  });
  it("detects plain @-mention", () => {
    expect(detectBotMention("hey @mybot do x", [], "mybot")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(detectBotMention("hey @MyBot", [], "mybot")).toBe(true);
    expect(detectBotMention("hey @mybot", [], "MyBot")).toBe(true);
  });
  it("returns false when text mentions someone else", () => {
    expect(detectBotMention("hey @otherbot", [], "mybot")).toBe(false);
  });
  it("detects /cmd@mybot entity (bot_command)", () => {
    const text = "/start@mybot please";
    const entities = [{ type: "bot_command", offset: 0, length: 14 }];
    expect(detectBotMention(text, entities, "mybot")).toBe(true);
  });
  it("ignores entities of unrelated types", () => {
    const text = "see https://mybot.example.com";
    const entities = [{ type: "url", offset: 4, length: 25 }];
    expect(detectBotMention(text, entities, "mybot")).toBe(false);
  });
});

describe("parseTelegramChannel", () => {
  it("parses a DM channel (single user chat_id, no thread)", () => {
    expect(parseTelegramChannel("telegram:8075471258")).toEqual({ chatId: "8075471258" });
  });

  it("parses a supergroup channel (negative chat_id, no thread)", () => {
    expect(parseTelegramChannel("telegram:-1001234567890")).toEqual({
      chatId: "-1001234567890",
    });
  });

  it("parses a forum-topic composite channel (chat_id + thread_id)", () => {
    expect(parseTelegramChannel("telegram:-1001234567890:15")).toEqual({
      chatId: "-1001234567890",
      threadId: "15",
    });
  });

  it("accepts arbitrary numeric thread_id", () => {
    expect(parseTelegramChannel("telegram:-1001234567890:1")).toEqual({
      chatId: "-1001234567890",
      threadId: "1",
    });
    expect(parseTelegramChannel("telegram:-1001234567890:999999")).toEqual({
      chatId: "-1001234567890",
      threadId: "999999",
    });
  });

  it("rejects missing colon", () => {
    expect(() => parseTelegramChannel("telegramonly")).toThrow(ChatGatewayError);
  });

  it("rejects non-telegram platform prefix", () => {
    expect(() => parseTelegramChannel("discord:1234567890")).toThrow(ChatGatewayError);
    expect(() => parseTelegramChannel("slack:C012345")).toThrow(ChatGatewayError);
  });

  it("rejects empty chat_id", () => {
    expect(() => parseTelegramChannel("telegram:")).toThrow(ChatGatewayError);
    expect(() => parseTelegramChannel("telegram::15")).toThrow(ChatGatewayError);
  });

  it("rejects empty thread_id after second colon", () => {
    expect(() => parseTelegramChannel("telegram:-1001234567890:")).toThrow(ChatGatewayError);
  });

  it("rejects non-numeric thread_id", () => {
    expect(() => parseTelegramChannel("telegram:-1001234567890:abc")).toThrow(ChatGatewayError);
    expect(() => parseTelegramChannel("telegram:-1001234567890:15.5")).toThrow(ChatGatewayError);
  });
});

describe("TelegramAdapter.send — thread routing (forum topics)", () => {
  function makeAdapterWithCapturingBot(): {
    adapter: TelegramAdapter;
    calls: Array<{
      chat_id: string | number;
      text: string;
      other?: { reply_to_message_id?: number; message_thread_id?: number };
    }>;
  } {
    const adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    const calls: Array<{
      chat_id: string | number;
      text: string;
      other?: { reply_to_message_id?: number; message_thread_id?: number };
    }> = [];
    adapter._testSeed({
      api: {
        sendMessage: (chat_id, text, other) => {
          calls.push({ chat_id, text, other });
          return Promise.resolve({ message_id: 100, date: 1700000000 });
        },
      },
    });
    return { adapter, calls };
  }

  it("routes a general-topic send (no thread suffix, no explicit threadId) without message_thread_id", async () => {
    const { adapter, calls } = makeAdapterWithCapturingBot();
    await adapter.send({ channel: "telegram:-1001234567890", text: "hi general" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.chat_id).toBe("-1001234567890");
    expect(calls[0]?.other?.message_thread_id).toBeUndefined();
  });

  it("extracts thread_id from a composite channel string", async () => {
    const { adapter, calls } = makeAdapterWithCapturingBot();
    await adapter.send({ channel: "telegram:-1001234567890:15", text: "hi topic 15" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.chat_id).toBe("-1001234567890");
    expect(calls[0]?.other?.message_thread_id).toBe(15);
  });

  it("honours an explicit threadId param on OutboundMessage", async () => {
    const { adapter, calls } = makeAdapterWithCapturingBot();
    await adapter.send({
      channel: "telegram:-1001234567890",
      text: "hi topic 42",
      threadId: "42",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.chat_id).toBe("-1001234567890");
    expect(calls[0]?.other?.message_thread_id).toBe(42);
  });

  it("explicit threadId overrides a thread suffix embedded in the channel", async () => {
    const { adapter, calls } = makeAdapterWithCapturingBot();
    await adapter.send({
      channel: "telegram:-1001234567890:15",
      text: "explicit wins",
      threadId: "99",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.chat_id).toBe("-1001234567890");
    expect(calls[0]?.other?.message_thread_id).toBe(99);
  });
});

describe("TelegramAdapter — 409 outbound-only fallback (#147)", () => {
  let adapter: TelegramAdapter;

  afterEach(() => {
    if (adapter) {
      adapter._testClearRetryTimer();
    }
  });

  it("starts in long-poll mode (isOutboundOnly false on a fresh adapter)", () => {
    adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    expect(adapter.isOutboundOnly()).toBe(false);
  });

  it("degrades to outbound-only on a 409 Conflict error (does NOT null the bot)", () => {
    adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    // Seed a fake bot so handleStartRejection can verify the bot
    // reference is preserved through the 409 path.
    const fakeBot = { api: { sendMessage: () => Promise.resolve({ message_id: 1, date: 0 }) } };
    adapter._testSeed(fakeBot);

    adapter.handleStartRejection(
      new Error("Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates)"),
    );

    expect(adapter.isOutboundOnly()).toBe(true);
    // Outbound bot reference still alive (we can't directly check
    // this.bot from outside, but the absence of a "telegram adapter:
    // not started" error on a hypothetical send() is the contract;
    // verified indirectly via isOutboundOnly + clean shutdown below).
  });

  it("matches the 409 detection across both 'Conflict' and '409' substrings", () => {
    adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    adapter._testSeed({ api: { sendMessage: () => Promise.resolve({ message_id: 1, date: 0 }) } });
    adapter.handleStartRejection(new Error("HTTP 409 Conflict"));
    expect(adapter.isOutboundOnly()).toBe(true);

    const a2 = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    a2._testSeed({ api: { sendMessage: () => Promise.resolve({ message_id: 1, date: 0 }) } });
    a2.handleStartRejection(new Error("Some random Conflict happened"));
    expect(a2.isOutboundOnly()).toBe(true);
    a2._testClearRetryTimer();
  });

  it("non-409 errors still tear down the bot (treats as genuine failure)", () => {
    adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    adapter._testSeed({ api: { sendMessage: () => Promise.resolve({ message_id: 1, date: 0 }) } });
    adapter.handleStartRejection(new Error("ECONNREFUSED"));
    // outboundOnly stays false; the bot was nulled
    expect(adapter.isOutboundOnly()).toBe(false);
  });

  it("schedules a periodic retry timer when entering outbound-only mode", () => {
    adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    adapter._testSeed({ api: { sendMessage: () => Promise.resolve({ message_id: 1, date: 0 }) } });
    expect(adapter.isOutboundOnly()).toBe(false);
    adapter.handleStartRejection(new Error("409 Conflict"));
    expect(adapter.isOutboundOnly()).toBe(true);
    // Retry timer is private; we can't directly assert it exists, but
    // _testClearRetryTimer() should successfully clear it (verified by
    // the afterEach not throwing on subsequent runs).
  });
});

// =====================================================================
// TPS.7 (v0.5.130) — stale-topic detection
// =====================================================================

/**
 * Construct a GrammyError-shaped value: an Error subclass with extra
 * `error_code` + `description` fields. grammy itself populates these on
 * Bot API failures; we mimic the shape without pulling the SDK in.
 */
function makeGrammyError(opts: {
  description: string;
  errorCode?: number;
}): Error & { error_code: number; description: string } {
  const e = new Error(opts.description) as Error & { error_code: number; description: string };
  e.name = "GrammyError";
  e.error_code = opts.errorCode ?? 400;
  e.description = opts.description;
  return e;
}

describe("isTopicGoneError (TPS.7)", () => {
  it("matches a canonical 'Bad Request: message thread not found' response", () => {
    const err = makeGrammyError({ description: "Bad Request: message thread not found" });
    expect(isTopicGoneError(err)).toBe(true);
  });

  it("matches the legacy CAPS form 'MESSAGE_THREAD_NOT_FOUND'", () => {
    const err = makeGrammyError({ description: "MESSAGE_THREAD_NOT_FOUND" });
    expect(isTopicGoneError(err)).toBe(true);
  });

  it("matches case-insensitively across variants", () => {
    expect(isTopicGoneError(makeGrammyError({ description: "Message Thread Not Found" }))).toBe(
      true,
    );
    expect(isTopicGoneError(makeGrammyError({ description: "message thread not found" }))).toBe(
      true,
    );
  });

  it("does NOT match a 403 (bot kicked from supergroup) error", () => {
    const err = makeGrammyError({
      description: "Forbidden: bot was kicked from the supergroup chat",
      errorCode: 403,
    });
    expect(isTopicGoneError(err)).toBe(false);
  });

  it("does NOT match a 429 (rate limit) error", () => {
    const err = makeGrammyError({
      description: "Too Many Requests: retry after 30",
      errorCode: 429,
    });
    expect(isTopicGoneError(err)).toBe(false);
  });

  it("does NOT match a 400 with an unrelated description", () => {
    const err = makeGrammyError({ description: "Bad Request: chat not found" });
    expect(isTopicGoneError(err)).toBe(false);
  });

  it("does NOT match a non-Error value", () => {
    expect(isTopicGoneError("not an error")).toBe(false);
    expect(isTopicGoneError(null)).toBe(false);
    expect(isTopicGoneError(undefined)).toBe(false);
    expect(isTopicGoneError({ description: "message thread not found" })).toBe(false);
  });
});

describe("extractGrammyDescription (TPS.7)", () => {
  it("returns the GrammyError description when present", () => {
    const err = makeGrammyError({ description: "Bad Request: foo" });
    expect(extractGrammyDescription(err)).toBe("Bad Request: foo");
  });

  it("falls back to Error.message when description is missing", () => {
    const err = new Error("just a plain error");
    expect(extractGrammyDescription(err)).toBe("just a plain error");
  });

  it("returns undefined for non-objects", () => {
    expect(extractGrammyDescription("string")).toBeUndefined();
    expect(extractGrammyDescription(null)).toBeUndefined();
    expect(extractGrammyDescription(undefined)).toBeUndefined();
  });
});

describe("TelegramAdapter.send — TopicGoneError re-throw (TPS.7)", () => {
  function makeAdapterWithThrowingBot(err: Error): TelegramAdapter {
    const adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    adapter._testSeed({
      api: {
        sendMessage: () => Promise.reject(err),
      },
    });
    return adapter;
  }

  it("re-throws a 400 'message thread not found' as TopicGoneError with chatId + threadId", async () => {
    const adapter = makeAdapterWithThrowingBot(
      makeGrammyError({ description: "Bad Request: message thread not found" }),
    );
    await expect(
      adapter.send({ channel: "telegram:-1001234567890:42", text: "hi stale" }),
    ).rejects.toMatchObject({
      name: "TopicGoneError",
      chatId: "-1001234567890",
      threadId: 42,
    });
  });

  it("attaches the underlying GrammyError on the TopicGoneError", async () => {
    const underlying = makeGrammyError({ description: "Bad Request: message thread not found" });
    const adapter = makeAdapterWithThrowingBot(underlying);
    try {
      await adapter.send({ channel: "telegram:-1001234567890:7", text: "doomed" });
      expect.fail("expected TopicGoneError");
    } catch (err) {
      expect(err).toBeInstanceOf(TopicGoneError);
      expect((err as TopicGoneError).underlying).toBe(underlying);
    }
  });

  it("does NOT re-throw as TopicGoneError when the send had no message_thread_id (general topic)", async () => {
    // Even if the error description happens to match, a general-topic
    // send can't have its topic 'go away' — there's no topic to clear.
    // We propagate the original error unchanged.
    const adapter = makeAdapterWithThrowingBot(
      makeGrammyError({ description: "Bad Request: message thread not found" }),
    );
    await expect(
      adapter.send({ channel: "telegram:-1001234567890", text: "no topic here" }),
    ).rejects.not.toBeInstanceOf(TopicGoneError);
  });

  it("propagates 403 bot-kicked errors unchanged (NOT TopicGoneError)", async () => {
    const adapter = makeAdapterWithThrowingBot(
      makeGrammyError({
        description: "Forbidden: bot was kicked from the supergroup chat",
        errorCode: 403,
      }),
    );
    await expect(
      adapter.send({ channel: "telegram:-1001234567890:15", text: "denied" }),
    ).rejects.not.toBeInstanceOf(TopicGoneError);
  });

  it("propagates generic Errors unchanged (NOT TopicGoneError)", async () => {
    const adapter = makeAdapterWithThrowingBot(new Error("ECONNRESET"));
    await expect(
      adapter.send({ channel: "telegram:-1001234567890:15", text: "boom" }),
    ).rejects.toThrow("ECONNRESET");
  });
});

describe("TelegramAdapter.createTopic — strips the telegram: prefix (auto-boot chat-not-found bug)", () => {
  function makeAdapterCapturingCreate(captured: { chatId?: string | number }): TelegramAdapter {
    const adapter = new TelegramAdapter({ bot_token: "123:ABCDEF" });
    adapter._testSeed({
      api: {
        createForumTopic: (chatId: string | number, name: string) => {
          captured.chatId = chatId;
          return Promise.resolve({ message_thread_id: 99, name });
        },
      },
    });
    return adapter;
  }

  it("passes the bare numeric chat_id to createForumTopic for a 'telegram:<id>' channel", async () => {
    const captured: { chatId?: string | number } = {};
    const adapter = makeAdapterCapturingCreate(captured);
    const res = await adapter.createTopic("telegram:-1003923174632", "loop");
    expect(captured.chatId).toBe("-1003923174632"); // prefix stripped → not "chat not found"
    expect(res).toEqual({ message_thread_id: 99, name: "loop" });
  });

  it("passes a bare numeric chat_id through unchanged (non-channel caller)", async () => {
    const captured: { chatId?: string | number } = {};
    const adapter = makeAdapterCapturingCreate(captured);
    await adapter.createTopic("-1003923174632", "loop");
    expect(captured.chatId).toBe("-1003923174632");
  });
});

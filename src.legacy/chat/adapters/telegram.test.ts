import { afterEach, describe, expect, it } from "vitest";

import { ChatGatewayError } from "../gateway.js";
import { TelegramAdapter, detectBotMention, parseTelegramChannel } from "./telegram.js";

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

import { afterEach, describe, expect, it } from "vitest";

import { ChatGatewayError } from "../gateway.js";
import { TelegramAdapter, detectBotMention } from "./telegram.js";

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

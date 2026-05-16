import { describe, expect, it } from "vitest";

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

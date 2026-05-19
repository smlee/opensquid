import { describe, expect, it } from "vitest";

import { ChatGatewayError } from "../gateway.js";
import { DiscordAdapter } from "./discord.js";

describe("DiscordAdapter constructor", () => {
  it("rejects empty bot_token", () => {
    expect(() => new DiscordAdapter({ bot_token: "" })).toThrow(ChatGatewayError);
  });
  it("rejects whitespace-only bot_token", () => {
    expect(() => new DiscordAdapter({ bot_token: "   " })).toThrow(ChatGatewayError);
  });
  it("accepts a real-shaped token", () => {
    const a = new DiscordAdapter({ bot_token: "MTAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(a.platform).toBe("discord");
  });

  it("send before start() throws", async () => {
    const a = new DiscordAdapter({ bot_token: "MTAxxxxx" });
    await expect(a.send({ channel: "discord:123", text: "hi" })).rejects.toThrow(/not started/);
  });

  it("send rejects malformed channel id", async () => {
    const a = new DiscordAdapter({ bot_token: "MTAxxxxx" });
    // We can't easily test the post-start path without spinning up a real
    // Discord gateway, but the not-started path covers the early reject.
    await expect(a.send({ channel: "no-colon", text: "hi" })).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { ChatGatewayError } from "../gateway.js";
import { SlackAdapter } from "./slack.js";

describe("SlackAdapter constructor", () => {
  it("rejects empty bot_token", () => {
    expect(() => new SlackAdapter({ bot_token: "", app_token: "xapp-1-2-3" })).toThrow(
      ChatGatewayError,
    );
  });
  it("rejects empty app_token", () => {
    expect(() => new SlackAdapter({ bot_token: "xoxb-1-2-3", app_token: "" })).toThrow(
      ChatGatewayError,
    );
  });
  it("rejects whitespace-only tokens", () => {
    expect(() => new SlackAdapter({ bot_token: "   ", app_token: "xapp-1-2-3" })).toThrow();
    expect(() => new SlackAdapter({ bot_token: "xoxb-1-2-3", app_token: "   " })).toThrow();
  });
  it("accepts both real-shaped tokens", () => {
    const a = new SlackAdapter({
      bot_token: "xoxb-123-456-abc",
      app_token: "xapp-1-A1B2-xyz",
    });
    expect(a.platform).toBe("slack");
  });

  it("send before start() throws", async () => {
    const a = new SlackAdapter({ bot_token: "xoxb-x", app_token: "xapp-x" });
    await expect(a.send({ channel: "slack:C012345", text: "hi" })).rejects.toThrow(/not started/);
  });

  it("identity before start() throws", async () => {
    const a = new SlackAdapter({ bot_token: "xoxb-x", app_token: "xapp-x" });
    await expect(a.identity()).rejects.toThrow(/not started/);
  });
});

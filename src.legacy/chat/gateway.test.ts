import { describe, expect, it, vi } from "vitest";

import {
  type ChatAdapter,
  ChatGateway,
  ChatGatewayError,
  type ChatMessage,
  type ChatPlatform,
  type MessageHandler,
  type OutboundMessage,
  type SendResult,
  formatChannelId,
  nativeIdFromChannel,
  platformFromChannel,
} from "./gateway.js";

// ---------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------

class MockAdapter implements ChatAdapter {
  readonly platform: ChatPlatform;
  started = false;
  shutdownCalls = 0;
  sends: OutboundMessage[] = [];
  private handlers: MessageHandler[] = [];

  constructor(platform: ChatPlatform) {
    this.platform = platform;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls++;
    this.started = false;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sends.push(message);
    return {
      platform: this.platform,
      messageId: `mock-${this.sends.length}`,
      deliveredAt: new Date("2026-05-16T00:00:00Z"),
    };
  }

  async identity(): Promise<{ username: string; nativeId: string }> {
    return { username: `mock-${this.platform}-bot`, nativeId: "bot-1" };
  }

  // Test helper: simulate an inbound message.
  async simulateMessage(text: string, sender = "user-1"): Promise<void> {
    const msg: ChatMessage = {
      id: `m-${Date.now()}`,
      platform: this.platform,
      channel: formatChannelId(this.platform, "channel-1"),
      sender,
      senderId: sender,
      text,
      receivedAt: new Date("2026-05-16T00:00:00Z"),
      mentionsBot: false,
    };
    for (const h of this.handlers) await h(msg);
  }
}

// ---------------------------------------------------------------------
// channel id helpers
// ---------------------------------------------------------------------

describe("channel id helpers", () => {
  it("formatChannelId joins with colon", () => {
    expect(formatChannelId("telegram", "8075471258")).toBe("telegram:8075471258");
  });
  it("platformFromChannel parses telegram", () => {
    expect(platformFromChannel("telegram:8075471258")).toBe("telegram");
  });
  it("platformFromChannel parses discord", () => {
    expect(platformFromChannel("discord:1234567890")).toBe("discord");
  });
  it("platformFromChannel parses slack", () => {
    expect(platformFromChannel("slack:C012345")).toBe("slack");
  });
  it("platformFromChannel rejects unknown platform", () => {
    expect(() => platformFromChannel("hipchat:xyz")).toThrow(ChatGatewayError);
  });
  it("platformFromChannel rejects malformed", () => {
    expect(() => platformFromChannel("telegram-no-colon")).toThrow(ChatGatewayError);
  });
  it("nativeIdFromChannel strips the prefix", () => {
    expect(nativeIdFromChannel("telegram:8075471258")).toBe("8075471258");
  });
  it("nativeIdFromChannel preserves colons in native id (slack thread_ts)", () => {
    expect(nativeIdFromChannel("slack:C012345:1234.5678")).toBe("C012345:1234.5678");
  });
});

// ---------------------------------------------------------------------
// ChatGateway lifecycle
// ---------------------------------------------------------------------

describe("ChatGateway lifecycle", () => {
  it("start() calls start on every adapter", async () => {
    const tg = new MockAdapter("telegram");
    const dc = new MockAdapter("discord");
    const gw = new ChatGateway([tg, dc]);
    expect(tg.started).toBe(false);
    expect(dc.started).toBe(false);
    await gw.start();
    expect(tg.started).toBe(true);
    expect(dc.started).toBe(true);
  });

  it("start() is idempotent", async () => {
    const tg = new MockAdapter("telegram");
    const startSpy = vi.spyOn(tg, "start");
    const gw = new ChatGateway([tg]);
    await gw.start();
    await gw.start();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it("shutdown() closes every adapter", async () => {
    const tg = new MockAdapter("telegram");
    const dc = new MockAdapter("discord");
    const gw = new ChatGateway([tg, dc]);
    await gw.start();
    await gw.shutdown();
    expect(tg.shutdownCalls).toBe(1);
    expect(dc.shutdownCalls).toBe(1);
  });

  it("shutdown() before start is a no-op", async () => {
    const tg = new MockAdapter("telegram");
    const gw = new ChatGateway([tg]);
    await gw.shutdown();
    expect(tg.shutdownCalls).toBe(0);
  });

  it("activePlatforms reports configured set", () => {
    const tg = new MockAdapter("telegram");
    const sl = new MockAdapter("slack");
    const gw = new ChatGateway([tg, sl]);
    expect(gw.activePlatforms().sort()).toEqual(["slack", "telegram"]);
  });
});

// ---------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------

describe("ChatGateway routing", () => {
  it("send() routes to the adapter matching the channel prefix", async () => {
    const tg = new MockAdapter("telegram");
    const dc = new MockAdapter("discord");
    const gw = new ChatGateway([tg, dc]);
    await gw.start();
    await gw.send({ channel: "telegram:8075471258", text: "hi tg" });
    await gw.send({ channel: "discord:1234", text: "hi dc" });
    expect(tg.sends.map((s) => s.text)).toEqual(["hi tg"]);
    expect(dc.sends.map((s) => s.text)).toEqual(["hi dc"]);
  });

  it("send() throws when no adapter is configured for the platform", async () => {
    const tg = new MockAdapter("telegram");
    const gw = new ChatGateway([tg]);
    await gw.start();
    await expect(gw.send({ channel: "slack:C012", text: "hi" })).rejects.toThrow(ChatGatewayError);
  });
});

// ---------------------------------------------------------------------
// Inbound dispatch
// ---------------------------------------------------------------------

describe("ChatGateway inbound dispatch", () => {
  it("forwards inbound messages to all registered handlers", async () => {
    const tg = new MockAdapter("telegram");
    const gw = new ChatGateway([tg]);
    await gw.start();
    const h1 = vi.fn();
    const h2 = vi.fn();
    gw.onMessage(h1);
    gw.onMessage(h2);
    await tg.simulateMessage("hello");
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
    expect(h1.mock.calls[0][0].text).toBe("hello");
  });

  it("one handler throwing doesn't block the others", async () => {
    const tg = new MockAdapter("telegram");
    const gw = new ChatGateway([tg]);
    await gw.start();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    gw.onMessage(failing);
    gw.onMessage(ok);
    await tg.simulateMessage("test");
    expect(failing).toHaveBeenCalledOnce();
    expect(ok).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("messages route through with correct platform tag", async () => {
    const dc = new MockAdapter("discord");
    const gw = new ChatGateway([dc]);
    await gw.start();
    const captured: ChatMessage[] = [];
    gw.onMessage((m) => {
      captured.push(m);
    });
    await dc.simulateMessage("from discord");
    expect(captured).toHaveLength(1);
    expect(captured[0].platform).toBe("discord");
    expect(captured[0].channel).toBe("discord:channel-1");
  });
});

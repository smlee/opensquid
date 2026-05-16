import { describe, expect, it, vi } from "vitest";

import { ChatGatewayError } from "./gateway.js";
import { buildChatGateway } from "./factory.js";

describe("buildChatGateway", () => {
  it("returns an empty gateway when no chat config is present", async () => {
    const result = await buildChatGateway({ config: {} });
    expect(result.activated).toEqual([]);
    expect(result.gateway.activePlatforms()).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it("skips discord + slack with a warning (v0.7a — not yet implemented)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await buildChatGateway({
      config: {
        discord: { bot_token: "MTAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
        slack: {
          bot_token: "xoxb-1-2-3",
          app_token: "xapp-1-2-3",
        },
      },
    });
    expect(result.activated).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("activates telegram when its config block is valid", async () => {
    const result = await buildChatGateway({
      config: { telegram: { bot_token: "123456:ABC-DEF1234" } },
    });
    expect(result.activated).toEqual(["telegram"]);
    expect(result.gateway.activePlatforms()).toEqual(["telegram"]);
  });

  it("skips telegram with invalid token format AND throws because no other adapter activated", async () => {
    await expect(
      buildChatGateway({
        config: { telegram: { bot_token: "not-a-real-format" } },
      }),
    ).rejects.toThrow(ChatGatewayError);
  });

  it("partial config: telegram valid + slack invalid → telegram activates, slack issue logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await buildChatGateway({
      config: {
        telegram: { bot_token: "123456:ABC-DEF1234" },
        // slack with wrong-shape tokens triggers validation issues
        slack: { bot_token: "wrong-prefix", app_token: "also-wrong" },
      },
    });
    expect(result.activated).toEqual(["telegram"]);
    expect(result.issues.find((i) => i.platform === "slack")).toBeTruthy();
    warn.mockRestore();
  });
});

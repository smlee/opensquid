/**
 * Build a ChatGateway from `~/.opensquid/config.json`'s
 * `chat_connections` block. Skips adapters whose tokens are missing —
 * opensquid works with zero, one, or all three chat platforms wired.
 *
 * Per-platform adapter modules (telegram/discord/slack) are imported
 * dynamically here so the factory doesn't pull all three SDK trees
 * into the cold-start path. Each adapter's own dynamic-import of its
 * SDK runs only inside `.start()`.
 */

import type { ChatAdapter } from "./gateway.js";
import { ChatGateway, ChatGatewayError } from "./gateway.js";
import { loadChatConfig, validateChatConfig } from "./config.js";
import type { ChatConnectionsConfig } from "./config.js";

export interface BuildOptions {
  dataRoot?: string;
  /** Inject a pre-loaded config (skips disk read). For tests. */
  config?: ChatConnectionsConfig;
}

export interface BuildResult {
  gateway: ChatGateway;
  /** Platforms that ended up in the gateway. */
  activated: Array<"telegram" | "discord" | "slack">;
  /** Validation issues — surfaced but non-fatal for partial activation. */
  issues: Array<{ platform: string; field: string; problem: string }>;
}

export async function buildChatGateway(opts: BuildOptions = {}): Promise<BuildResult> {
  const config = opts.config ?? (await loadChatConfig(opts.dataRoot));
  const issues = validateChatConfig(config);

  const adapters: ChatAdapter[] = [];
  const activated: BuildResult["activated"] = [];

  // Each block: only activate if (a) config block exists AND (b) no
  // validation issue against this platform's tokens. An issue here
  // means the user has a partial config (e.g. typo'd token) — better
  // to skip with a logged warning than throw and prevent the other
  // adapters from working.
  if (config.telegram && !issues.some((i) => i.platform === "telegram")) {
    const { TelegramAdapter } = await import("./adapters/telegram.js");
    adapters.push(new TelegramAdapter(config.telegram));
    activated.push("telegram");
  }
  // Discord adapter ships in v0.7b — placeholder branch keeps the factory
  // forward-compatible without a hard failure on configured-but-not-yet-
  // implemented platforms.
  if (config.discord && !issues.some((i) => i.platform === "discord")) {
    // eslint-disable-next-line no-console
    console.warn("[chat factory] discord adapter not yet implemented (v0.7b) — skipping");
  }
  // Slack adapter ships in v0.7c.
  if (config.slack && !issues.some((i) => i.platform === "slack")) {
    // eslint-disable-next-line no-console
    console.warn("[chat factory] slack adapter not yet implemented (v0.7c) — skipping");
  }

  // Throw ONLY when the user clearly mis-configured a token (validation
  // issue against a platform whose adapter we DO have). Unimplemented
  // platforms (v0.7a: discord, slack) are silent-skipped with a warning
  // because the user may have pre-configured them in anticipation of
  // v0.7b/c — crashing opensquid would punish forward-looking setup.
  const blockingIssues = issues.filter((i) => i.platform === "telegram" && !!config.telegram);
  if (blockingIssues.length > 0 && adapters.length === 0) {
    throw new ChatGatewayError(
      "chat connections configured but failed validation — see issues",
      `validation: ${blockingIssues
        .map((i) => `${i.platform}.${i.field}: ${i.problem}`)
        .join("; ")}`,
    );
  }

  return { gateway: new ChatGateway(adapters), activated, issues };
}

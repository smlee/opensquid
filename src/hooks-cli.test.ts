/**
 * Tests for #118 — hooks-cli legacy entry detection + per-event HOOK_IDs.
 *
 * Covers `isOurHook` directly: recognition by per-event id, by legacy id,
 * by command-path fingerprint (un-marked entries from older installs),
 * and rejection of non-opensquid hooks.
 *
 * The install/uninstall integration tests are deferred — they touch the
 * user's real ~/.claude/settings.json and would need test-isolation
 * infrastructure that the hooks-cli module doesn't currently expose.
 */
import { describe, expect, it } from "vitest";

import { isOurHook } from "./hooks-cli.js";

describe("isOurHook — per-event marker detection", () => {
  it("recognizes the PreToolUse marker", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /path/to/something/dist/index.js hook pre-tool-use",
        _id: "opensquid-pre-tool-use",
      }),
    ).toBe(true);
  });

  it("recognizes the Stop marker", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /path/to/something/dist/index.js hook stop",
        _id: "opensquid-stop",
      }),
    ).toBe(true);
  });

  it("recognizes the UserPromptSubmit marker", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /path/to/something/dist/index.js hook user-prompt-submit",
        _id: "opensquid-user-prompt-submit",
      }),
    ).toBe(true);
  });

  it("recognizes the SessionEnd marker", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /path/to/something/dist/index.js hook session-end",
        _id: "opensquid-session-end",
      }),
    ).toBe(true);
  });
});

describe("isOurHook — legacy marker detection (pre-#118)", () => {
  it("recognizes the legacy opensquid-drift-pretooluse id even on Stop entries", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /opt/foo/opensquid/dist/index.js hook stop",
        _id: "opensquid-drift-pretooluse",
      }),
    ).toBe(true);
  });
});

describe("isOurHook — command-path fallback (un-marked legacy entries)", () => {
  it("recognizes un-marked entries by command-path fingerprint", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /Users/alice/projects/opensquid/dist/index.js hook pre-tool-use",
        // No _id — the bug from #118 dogfood that left these undetected.
      }),
    ).toBe(true);
  });

  it("recognizes un-marked entries with absolute paths", () => {
    expect(
      isOurHook({
        type: "command",
        command: "/usr/local/bin/node /opt/opensquid/dist/index.js hook stop",
      }),
    ).toBe(true);
  });

  it("matches case-insensitively (macOS APFS case-preserving)", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /Users/alice/projects/OpenSquid/dist/index.js hook pre-tool-use",
      }),
    ).toBe(true);
    expect(
      isOurHook({
        type: "command",
        command: "node /OPENSQUID/dist/index.js hook stop",
      }),
    ).toBe(true);
  });

  it("does NOT match commands that incidentally contain 'opensquid' in unrelated context", () => {
    expect(
      isOurHook({
        type: "command",
        command: "echo 'I love opensquid'",
      }),
    ).toBe(false);
  });

  it("does NOT match similarly-named third-party tools", () => {
    expect(
      isOurHook({
        type: "command",
        command: "node /opt/some-other/dist/index.js hook stop",
      }),
    ).toBe(false);
  });
});

describe("FALSE_STOP_GUARD_PROMPT content (0.7.31 — squid emoji prefix)", () => {
  it("install writes a Stop prompt hook whose prompt instructs Haiku to prefix with 🦑 [opensquid D9-guard]", async () => {
    // Indirect: re-load the source file content via the install module
    // and verify the embedded prompt string contains the marker. Avoids
    // monkeypatching ~/.claude/settings.json in CI.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const sourcePath = path.join(path.dirname(here), "hooks-cli.ts");
    const src = await fs.readFile(sourcePath, "utf8");
    expect(src).toContain("🦑 [opensquid D9-guard]");
  });
});

describe("isOurHook — prompt-type Stop guard (0.7.20 / drift D9)", () => {
  it("recognizes the false-stop guard prompt hook by _id", () => {
    expect(
      isOurHook({
        type: "prompt",
        prompt: "any prompt text",
        model: "claude-haiku-4-5",
        _id: "opensquid-stop-false-stop-guard",
      }),
    ).toBe(true);
  });

  it("rejects a prompt-type entry with a foreign _id (no command fingerprint to fall back on)", () => {
    expect(
      isOurHook({
        type: "prompt",
        prompt: "some other prompt",
        model: "claude-haiku-4-5",
        _id: "other-tool-prompt-hook",
      }),
    ).toBe(false);
  });

  it("rejects an unmarked prompt-type entry (no _id, no command field)", () => {
    expect(
      isOurHook({
        type: "prompt",
        prompt: "unmarked prompt",
      }),
    ).toBe(false);
  });
});

describe("isOurHook — rejection of foreign hooks", () => {
  it("rejects entries with a different _id and a non-matching command", () => {
    expect(
      isOurHook({
        type: "command",
        command: "bun run /Users/slee/claude-memory/scripts/sync-to-supabase.ts",
        _id: "memory-sync",
      }),
    ).toBe(false);
  });

  it("rejects entries with no _id and a non-matching command", () => {
    expect(
      isOurHook({
        type: "command",
        command: "/usr/local/bin/some-other-hook --flag",
      }),
    ).toBe(false);
  });

  it("rejects empty command", () => {
    expect(
      isOurHook({
        type: "command",
        command: "",
      }),
    ).toBe(false);
  });
});

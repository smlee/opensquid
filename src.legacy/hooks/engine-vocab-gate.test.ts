/**
 * Tests for engine-vocab-gate (0.7.21 / drift D6).
 *
 * Covers the pure-function decomposition (isEngineRepoCwd,
 * scanCommitMessage, parseDiffForConsumerNames) so we don't need to
 * set up a git fixture for every assertion. End-to-end coverage via
 * the existing pre-tool-use integration tests is left as a follow-up.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkOverrideEnv,
  isEngineRepoCwd,
  parseDiffForConsumerNames,
  scanCommitMessage,
} from "./engine-vocab-gate.js";

describe("isEngineRepoCwd", () => {
  it("matches monorepo engine subdir", () => {
    expect(isEngineRepoCwd("/Users/slee/projects/loop/engine")).toBe(true);
  });

  it("matches monorepo engine subdir with trailing slash", () => {
    expect(isEngineRepoCwd("/Users/slee/projects/loop/engine/")).toBe(true);
  });

  it("matches standalone loop-engine repo", () => {
    expect(isEngineRepoCwd("/Users/slee/projects/loop-engine")).toBe(true);
  });

  it("matches any other -engine repo", () => {
    expect(isEngineRepoCwd("/home/alice/work/search-engine")).toBe(true);
  });

  it("does NOT match an unrelated subdir", () => {
    expect(isEngineRepoCwd("/Users/slee/projects/loop/opensquid")).toBe(false);
  });

  it("does NOT match a path that just contains 'engine' in the middle", () => {
    expect(isEngineRepoCwd("/Users/slee/engine-tutorials/lesson1")).toBe(false);
  });

  it("does NOT match the repo parent (loop monorepo root)", () => {
    expect(isEngineRepoCwd("/Users/slee/projects/loop")).toBe(false);
  });
});

describe("scanCommitMessage", () => {
  it("flags 'opensquid' in a -m message", () => {
    expect(scanCommitMessage('git commit -m "ships in lockstep with opensquid 0.7.11"')).toBe(
      "opensquid",
    );
  });

  it("flags 'opensquid' in a HEREDOC -m body", () => {
    const cmd = `git commit -m "$(cat <<'EOF'
fix something
ships alongside opensquid 0.7.x
EOF
)"`;
    expect(scanCommitMessage(cmd)).toBe("opensquid");
  });

  it("flags 'claude code' with various separators", () => {
    expect(scanCommitMessage('git commit -m "tested against Claude Code session UUID"')).toBe(
      "Claude Code",
    );
    expect(scanCommitMessage('git commit -m "claude_code adapter update"')).toBe("claude_code");
    expect(scanCommitMessage('git commit -m "claude-code session"')).toBe("claude-code");
  });

  it("returns null on a clean engine commit message", () => {
    expect(
      scanCommitMessage('git commit -m "fix(phase_ledger): drop session_id from storage scheme"'),
    ).toBeNull();
  });

  it("returns null when there is no -m flag at all", () => {
    expect(scanCommitMessage("git status")).toBeNull();
    expect(scanCommitMessage("git commit")).toBeNull();
  });

  it("does NOT false-fire on substrings like 'openssquidly'", () => {
    // CONSUMER_NAME_REGEX uses \b word boundaries so partial matches don't trip.
    expect(scanCommitMessage('git commit -m "openssquidly is not a real word"')).toBeNull();
  });
});

describe("parseDiffForConsumerNames", () => {
  it("flags an added line in CHANGELOG.md that mentions opensquid", () => {
    const diff = `diff --git a/CHANGELOG.md b/CHANGELOG.md
index abc..def 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,3 +1,4 @@
+ships in lockstep with opensquid 0.7.11
 existing line
`;
    const hits = parseDiffForConsumerNames(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe("CHANGELOG.md");
    expect(hits[0].match).toBe("opensquid");
  });

  it("flags an added comment in src/lib.rs that mentions 'Claude Code'", () => {
    const diff = `diff --git a/src/lib.rs b/src/lib.rs
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -10,0 +11 @@
+    // Tested against Claude Code session UUID format.
`;
    const hits = parseDiffForConsumerNames(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe("src/lib.rs");
  });

  it("does NOT flag added lines under src/host/claude_code/", () => {
    const diff = `diff --git a/src/host/claude_code/adapter.rs b/src/host/claude_code/adapter.rs
--- a/src/host/claude_code/adapter.rs
+++ b/src/host/claude_code/adapter.rs
@@ -0,0 +1 @@
+// Claude Code-specific adapter logic — opensquid is the consumer.
`;
    const hits = parseDiffForConsumerNames(diff);
    expect(hits).toHaveLength(0);
  });

  it("does NOT flag MIT attribution comment lines", () => {
    const diff = `diff --git a/src/engine/buffer.rs b/src/engine/buffer.rs
--- a/src/engine/buffer.rs
+++ b/src/engine/buffer.rs
@@ -0,0 +1 @@
+// MIT-licensed code cherry-picked from claude_code's transcript reader.
`;
    const hits = parseDiffForConsumerNames(diff);
    expect(hits).toHaveLength(0);
  });

  it("does NOT flag removed lines (we only care about additions)", () => {
    const diff = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,2 +1,1 @@
-old line that mentioned opensquid
 kept line
`;
    const hits = parseDiffForConsumerNames(diff);
    expect(hits).toHaveLength(0);
  });

  it("returns empty array on a fully clean engine diff", () => {
    const diff = `diff --git a/src/engine/mod.rs b/src/engine/mod.rs
--- a/src/engine/mod.rs
+++ b/src/engine/mod.rs
@@ -10,0 +11 @@
+    let task_id = ctx.task_id();
`;
    expect(parseDiffForConsumerNames(diff)).toEqual([]);
  });

  it("collects multiple hits across multiple files", () => {
    const diff = `diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,0 +1 @@
+now compatible with opensquid 0.7.x
diff --git a/src/serve.rs b/src/serve.rs
--- a/src/serve.rs
+++ b/src/serve.rs
@@ -10,0 +11 @@
+    // The opensquid MCP server expects this format.
`;
    const hits = parseDiffForConsumerNames(diff);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.file)).toEqual(["CHANGELOG.md", "src/serve.rs"]);
  });
});

describe("checkOverrideEnv", () => {
  const previousValue = process.env.OPENSQUID_SKIP_ENGINE_VOCAB_GATE;

  beforeEach(() => {
    delete process.env.OPENSQUID_SKIP_ENGINE_VOCAB_GATE;
  });
  afterEach(() => {
    if (previousValue === undefined) {
      delete process.env.OPENSQUID_SKIP_ENGINE_VOCAB_GATE;
    } else {
      process.env.OPENSQUID_SKIP_ENGINE_VOCAB_GATE = previousValue;
    }
  });

  it("returns true when the env var is exactly '1'", () => {
    process.env.OPENSQUID_SKIP_ENGINE_VOCAB_GATE = "1";
    expect(checkOverrideEnv()).toBe(true);
  });

  it("returns false when the env var is unset", () => {
    expect(checkOverrideEnv()).toBe(false);
  });

  it("returns false when the env var is some other value", () => {
    process.env.OPENSQUID_SKIP_ENGINE_VOCAB_GATE = "true";
    expect(checkOverrideEnv()).toBe(false);
  });
});

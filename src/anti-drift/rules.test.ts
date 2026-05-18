/**
 * Tests for anti-drift/rules.ts (0.7.33 unified-evaluator track).
 *
 * Validates:
 *   1. Catalog shape — every rule has the required fields
 *   2. rulesForEvent filtering — by event + bypass env var
 *   3. evaluateRules behavior — PreToolUse short-circuits on block
 *   4. Specific rule when() predicates fire correctly
 *
 * Deep behavioral coverage of each rule's check() lives in the
 * existing src/hooks/*.test.ts suites (since the rules delegate
 * there). The 0.7.35 cutover migrates those tests alongside.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RULES,
  evaluateRules,
  rulesForEvent,
  type HookContext,
  type HookEvent,
  type Rule,
} from "./rules.js";

describe("RULES catalog shape", () => {
  it("has at least 16 rules (matches the design doc's 18, allowing 1-2 implementation merges)", () => {
    expect(RULES.length).toBeGreaterThanOrEqual(16);
  });

  it("every rule has all required fields populated", () => {
    for (const r of RULES) {
      expect(r.id).toBeTruthy();
      expect(r.catches).toBeTruthy();
      expect(["PreToolUse", "Stop", "UserPromptSubmit", "SessionEnd"]).toContain(r.hook);
      expect(typeof r.when).toBe("function");
      expect(typeof r.check).toBe("function");
      expect(r.rationale).toBeTruthy();
    }
  });

  it("rule ids are unique", () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all 10 drift D-entries (by `catches` field)", () => {
    const covered = new Set(
      RULES.map((r) => r.catches).flatMap((c) => c.split("+").map((s) => s.trim())),
    );
    for (const drift of ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10"]) {
      expect(
        [...covered].some((c) => c === drift || c.startsWith(drift)),
        `expected catches to include ${drift}`,
      ).toBe(true);
    }
  });
});

describe("rulesForEvent", () => {
  it("filters by hook event", () => {
    const preRules = rulesForEvent("PreToolUse");
    expect(preRules.every((r) => r.hook === "PreToolUse")).toBe(true);
    expect(preRules.length).toBeGreaterThan(0);
  });

  it("excludes bypassed rules", () => {
    const target = RULES.find((r) => r.id === "active-task-required");
    expect(target).toBeDefined();
    expect(target!.bypass).toBe("OPENSQUID_SKIP_ACTIVE_TASK_GATE");
    process.env.OPENSQUID_SKIP_ACTIVE_TASK_GATE = "1";
    try {
      const ids = rulesForEvent("PreToolUse").map((r) => r.id);
      expect(ids).not.toContain("active-task-required");
    } finally {
      delete process.env.OPENSQUID_SKIP_ACTIVE_TASK_GATE;
    }
  });

  it("bypass env var must be exactly '1' (other values do NOT bypass)", () => {
    process.env.OPENSQUID_SKIP_ACTIVE_TASK_GATE = "true";
    try {
      const ids = rulesForEvent("PreToolUse").map((r) => r.id);
      expect(ids).toContain("active-task-required");
    } finally {
      delete process.env.OPENSQUID_SKIP_ACTIVE_TASK_GATE;
    }
  });
});

describe("rule when() predicates", () => {
  const preCtx = (toolName: string, command?: string): HookContext => ({
    hookEvent: "PreToolUse",
    toolName,
    toolInput: command !== undefined ? { command } : {},
  });

  it("active-task-required fires only on log_phase / chat_send", () => {
    const rule = RULES.find((r) => r.id === "active-task-required")!;
    expect(rule.when(preCtx("mcp__opensquid__log_phase"))).toBe(true);
    expect(rule.when(preCtx("mcp__opensquid__chat_send"))).toBe(true);
    expect(rule.when(preCtx("Bash", "ls"))).toBe(false);
    expect(rule.when(preCtx("Read"))).toBe(false);
  });

  it("never-amend.when fires on Bash tool", () => {
    const rule = RULES.find((r) => r.id === "never-amend")!;
    expect(rule.when(preCtx("Bash", "git commit --amend"))).toBe(true);
    // Filter happens inside check via drift-patterns; when() just gates by tool name.
    expect(rule.when(preCtx("Edit"))).toBe(false);
  });

  it("engine-vocab-leak fires only on git commit Bash commands", () => {
    const rule = RULES.find((r) => r.id === "engine-vocab-leak")!;
    expect(rule.when(preCtx("Bash", "git commit -m 'foo'"))).toBe(true);
    expect(rule.when(preCtx("Bash", "git status"))).toBe(false);
    expect(rule.when(preCtx("Bash"))).toBe(false);
  });

  it("heartbeat-recall-required fires on any mcp__opensquid__* tool", () => {
    const rule = RULES.find((r) => r.id === "heartbeat-recall-required")!;
    expect(rule.when(preCtx("mcp__opensquid__recall"))).toBe(true);
    expect(rule.when(preCtx("mcp__opensquid__log_phase"))).toBe(true);
    expect(rule.when(preCtx("mcp__opensquid__chat_send"))).toBe(true);
    expect(rule.when(preCtx("mcp__plugin_telegram_telegram__reply"))).toBe(false);
    expect(rule.when(preCtx("Bash"))).toBe(false);
  });

  it("telegram-redirect-report fires only on plugin:telegram reply", () => {
    const rule = RULES.find((r) => r.id === "telegram-redirect-report")!;
    expect(rule.when(preCtx("mcp__plugin_telegram_telegram__reply"))).toBe(true);
    expect(rule.when(preCtx("mcp__opensquid__chat_send"))).toBe(false);
  });

  it("inline-report-missing-phases fires on Stop with assistantText", () => {
    const rule = RULES.find((r) => r.id === "inline-report-missing-phases")!;
    expect(rule.when({ hookEvent: "Stop", assistantText: "hi" })).toBe(true);
    expect(rule.when({ hookEvent: "Stop" })).toBe(false);
  });

  it("multi-task-plan-injection fires on UPS with userPrompt", () => {
    const rule = RULES.find((r) => r.id === "multi-task-plan-injection")!;
    expect(rule.when({ hookEvent: "UserPromptSubmit", userPrompt: "166 then 168" })).toBe(true);
    expect(rule.when({ hookEvent: "UserPromptSubmit" })).toBe(false);
  });
});

describe("evaluateRules — short-circuit on PreToolUse block", () => {
  let originalRules: Rule[];
  beforeEach(() => {
    originalRules = [...RULES];
  });
  afterEach(() => {
    RULES.length = 0;
    RULES.push(...originalRules);
  });

  it("PreToolUse: stops at the first block verdict (most-restrictive-wins)", async () => {
    // Replace catalog with two fakes that both apply; the first blocks.
    RULES.length = 0;
    let secondRan = false;
    RULES.push(
      {
        id: "fake-block",
        catches: "test",
        hook: "PreToolUse",
        when: () => true,
        check: async () => ({ kind: "block", message: "first" }),
        rationale: "test",
      },
      {
        id: "fake-second",
        catches: "test",
        hook: "PreToolUse",
        when: () => true,
        check: async () => {
          secondRan = true;
          return { kind: "pass" };
        },
        rationale: "test",
      },
    );
    const verdicts = await evaluateRules({ hookEvent: "PreToolUse", toolName: "Bash" });
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]).toEqual({ kind: "block", message: "first" });
    expect(secondRan).toBe(false);
  });

  it("Stop: accumulates all verdicts (no short-circuit on first surface)", async () => {
    RULES.length = 0;
    RULES.push(
      {
        id: "fake-surface-a",
        catches: "test",
        hook: "Stop",
        when: () => true,
        check: async () => ({ kind: "surface", message: "a" }),
        rationale: "test",
      },
      {
        id: "fake-surface-b",
        catches: "test",
        hook: "Stop",
        when: () => true,
        check: async () => ({ kind: "surface", message: "b" }),
        rationale: "test",
      },
    );
    const verdicts = await evaluateRules({ hookEvent: "Stop", assistantText: "test" });
    expect(verdicts.length).toBe(2);
    expect(verdicts.map((v) => v.kind === "surface" && v.message)).toEqual(["a", "b"]);
  });

  it("skips rules whose when() returns false", async () => {
    RULES.length = 0;
    RULES.push({
      id: "fake-not-applicable",
      catches: "test",
      hook: "PreToolUse",
      when: () => false,
      check: async () => ({ kind: "block", message: "should not fire" }),
      rationale: "test",
    });
    const verdicts = await evaluateRules({ hookEvent: "PreToolUse", toolName: "Bash" });
    expect(verdicts).toEqual([]);
  });
});

describe("Verdict shape — pass / block / warn / surface", () => {
  it("PASS verdicts have no message field", () => {
    const v: import("./rules.js").Verdict = { kind: "pass" };
    expect(v.kind).toBe("pass");
    expect("message" in v).toBe(false);
  });

  it("non-pass verdicts carry a message", () => {
    const block: import("./rules.js").Verdict = { kind: "block", message: "x" };
    const warn: import("./rules.js").Verdict = { kind: "warn", message: "y" };
    const surface: import("./rules.js").Verdict = { kind: "surface", message: "z" };
    expect(block.message).toBe("x");
    expect(warn.message).toBe("y");
    expect(surface.message).toBe("z");
  });
});

describe("hook-event coverage", () => {
  it("each of the 4 hook events has at least one rule", () => {
    for (const event of ["PreToolUse", "Stop", "UserPromptSubmit", "SessionEnd"] as HookEvent[]) {
      const rules = RULES.filter((r) => r.hook === event);
      expect(rules.length, `expected at least one rule for ${event}`).toBeGreaterThan(0);
    }
  });
});

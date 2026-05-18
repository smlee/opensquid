/**
 * Tests for anti-drift/evaluator.ts (0.7.34 unified-evaluator track).
 *
 * Focused on aggregation semantics (PreToolUse short-circuit on block,
 * Stop+UPS surface/warn pass-through). End-to-end runner tests would
 * need stdin fixtures; covered by the existing src/hooks/*.test.ts
 * suites which exercise the same code paths via the legacy entry
 * points. 0.7.35 cutover migrates those tests.
 */
import { describe, expect, it } from "vitest";

import { aggregatePreToolUse } from "./evaluator.js";
import type { Verdict } from "./rules.js";

describe("aggregatePreToolUse", () => {
  it("returns exit 0 + empty stderr when no verdicts fired", () => {
    const r = aggregatePreToolUse([]);
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("returns exit 0 + empty stderr when all verdicts are pass", () => {
    const verdicts: Verdict[] = [{ kind: "pass" }, { kind: "pass" }];
    const r = aggregatePreToolUse(verdicts);
    expect(r.exit).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("returns exit 2 when any verdict is block", () => {
    const verdicts: Verdict[] = [{ kind: "pass" }, { kind: "block", message: "blocked because X" }];
    const r = aggregatePreToolUse(verdicts);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("blocked because X");
  });

  it("returns exit 0 + stderr when only warns fired", () => {
    const verdicts: Verdict[] = [
      { kind: "warn", message: "warn-A" },
      { kind: "warn", message: "warn-B" },
    ];
    const r = aggregatePreToolUse(verdicts);
    expect(r.exit).toBe(0);
    expect(r.stderr).toContain("warn-A");
    expect(r.stderr).toContain("warn-B");
  });

  it("blocks listed BEFORE warns in the combined stderr (most-restrictive surfaces first)", () => {
    const verdicts: Verdict[] = [
      { kind: "warn", message: "warn-first-in-input" },
      { kind: "block", message: "block-second-in-input" },
    ];
    const r = aggregatePreToolUse(verdicts);
    const blockIdx = r.stderr.indexOf("block-second-in-input");
    const warnIdx = r.stderr.indexOf("warn-first-in-input");
    expect(blockIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeLessThan(warnIdx);
  });

  it("appends trailing newline to stderr when non-empty", () => {
    const verdicts: Verdict[] = [{ kind: "warn", message: "x" }];
    const r = aggregatePreToolUse(verdicts);
    expect(r.stderr.endsWith("\n")).toBe(true);
  });
});

describe("runner semantics — block/warn aggregation contract", () => {
  it("multiple blocks all appear in stderr", () => {
    const verdicts: Verdict[] = [
      { kind: "block", message: "first block" },
      { kind: "block", message: "second block" },
    ];
    const r = aggregatePreToolUse(verdicts);
    expect(r.exit).toBe(2);
    expect(r.stderr).toContain("first block");
    expect(r.stderr).toContain("second block");
  });

  it("surface verdicts are NOT included in PreToolUse stderr (those route via Stop/UPS)", () => {
    const verdicts: Verdict[] = [
      { kind: "surface", message: "stop-surface should not appear" },
      { kind: "warn", message: "real warn appears" },
    ];
    const r = aggregatePreToolUse(verdicts);
    expect(r.stderr).not.toContain("stop-surface should not appear");
    expect(r.stderr).toContain("real warn appears");
  });
});

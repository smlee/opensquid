/**
 * Tests for inline-report-check (0.7.30 / D3 inline variant).
 *
 * Covers checkInlineReportFormat + the count helpers. Stop-hook
 * integration left to integration tests (it composes the existing
 * BrokenPromise pipeline which already has its own coverage).
 */
import { describe, expect, it } from "vitest";

import {
  checkInlineReportFormat,
  countCommitHashes,
  countVersionRefs,
  hasPhasesBlock,
} from "./inline-report-check.js";

describe("countVersionRefs", () => {
  it("counts distinct 0.X.Y refs", () => {
    expect(countVersionRefs("shipped 0.7.20 then 0.7.21 and 0.7.22")).toBe(3);
  });

  it("dedupes repeated mentions", () => {
    expect(countVersionRefs("0.7.20 fixed in 0.7.20 again")).toBe(1);
  });

  it("returns 0 on plain prose with no version", () => {
    expect(countVersionRefs("hello world, no versions here")).toBe(0);
  });

  it("does NOT count partial versions like '0.7'", () => {
    expect(countVersionRefs("the 0.7 series")).toBe(0);
  });
});

describe("countCommitHashes", () => {
  it("counts distinct 7-char hashes", () => {
    expect(countCommitHashes("see 92fe415 and 0e59ba3 and 40342e3")).toBe(3);
  });

  it("requires at least one a-f letter (excludes pure decimal)", () => {
    // 7-digit decimals like timestamps shouldn't trigger.
    expect(countCommitHashes("count is 1234567 and 9876543")).toBe(0);
  });

  it("counts full 40-char shas", () => {
    expect(countCommitHashes("4eaf39d2d21f0540342e3e881d2c47cde6d4ab39 abc")).toBe(1);
  });

  it("dedupes repeated hashes", () => {
    expect(countCommitHashes("92fe415 ... revisit 92fe415")).toBe(1);
  });
});

describe("hasPhasesBlock", () => {
  it("true for 'PHASES:' uppercase block", () => {
    expect(hasPhasesBlock("\nPHASES:\n- pre_research: ...")).toBe(true);
  });

  it("true for 'phases:' lowercase", () => {
    expect(hasPhasesBlock("phases:\n- x")).toBe(true);
  });

  it("true when 'PHASES' is followed by a newline", () => {
    expect(hasPhasesBlock("PHASES\n- pre_research")).toBe(true);
  });

  it("false when 'phases' appears in unrelated prose", () => {
    expect(hasPhasesBlock("we have three phases of testing")).toBe(false);
  });
});

describe("checkInlineReportFormat", () => {
  it("flags multi-version status report without PHASES", () => {
    const text = `Shipped 0.7.20, 0.7.21, 0.7.22 today. All tests green.`;
    const v = checkInlineReportFormat(text);
    expect(v).not.toBeNull();
    expect(v!.signals.version_refs).toBe(3);
  });

  it("flags multi-commit chain-ship without PHASES", () => {
    const text = `Commits: 92fe415, 0e59ba3, 40342e3, d6275a1 all pushed.`;
    const v = checkInlineReportFormat(text);
    expect(v).not.toBeNull();
    expect(v!.signals.hash_refs).toBeGreaterThanOrEqual(2);
  });

  it("does NOT flag when PHASES block is present", () => {
    const text = `🦑 #7 shipped 0.7.20, 0.7.21, 0.7.22.\n\nPHASES:\n- pre_research: ...\n- learn: ...\n- code: ...\n- test: ...\n- audit: ...\n- post_research: ...\n- fix: ...`;
    expect(checkInlineReportFormat(text)).toBeNull();
  });

  it("does NOT flag a single-version prose mention (signal too weak)", () => {
    const text = `I bumped opensquid to 0.7.30 in package.json.`;
    expect(checkInlineReportFormat(text)).toBeNull();
  });

  it("does NOT flag a single-commit-hash prose mention", () => {
    const text = `The commit 92fe415 introduced the D9 guard.`;
    expect(checkInlineReportFormat(text)).toBeNull();
  });

  it("does NOT flag empty input", () => {
    expect(checkInlineReportFormat("")).toBeNull();
  });

  it("matched_text condenses to <=120 chars + trims whitespace", () => {
    const long = "Shipped 0.7.20 and 0.7.21 today.\n\n".repeat(10);
    const v = checkInlineReportFormat(long);
    expect(v).not.toBeNull();
    expect(v!.matched_text.length).toBeLessThanOrEqual(120);
  });

  it("dogfood: catches the 'where are my 7 phases' incident shape", () => {
    // The user's complaint was the summary table I posted with 10
    // versions and 10 commit hashes but no PHASES heading.
    const text = `Final tally: 0.7.20 92fe415, 0.7.21 0e59ba3, 0.7.22 40342e3, 0.7.23 d6275a1, 0.7.24 e881d2c, 0.7.25 e47b65c, 0.7.26 2d21f05, 0.7.27 4ab3977, 0.7.28 47cde6d, 0.7.29 4eaf39d.`;
    const v = checkInlineReportFormat(text);
    expect(v).not.toBeNull();
    expect(v!.signals.version_refs).toBe(10);
    expect(v!.signals.hash_refs).toBe(10);
  });
});

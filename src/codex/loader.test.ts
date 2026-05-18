import { describe, expect, it, beforeEach } from "vitest";

import { __resetCachedCodexForTesting, loadBundledDefaultCodex } from "./loader.js";
import { isFocusedCodex } from "./types.js";

describe("loadBundledDefaultCodex", () => {
  beforeEach(() => {
    __resetCachedCodexForTesting();
  });

  it("loads the bundled-default codex and returns a focused codex", () => {
    const codex = loadBundledDefaultCodex();
    expect(codex.id).toBe("opensquid-default");
    expect(isFocusedCodex(codex)).toBe(true);
  });

  it("exposes the drift, workflow, claim, and policy sections (chunk 1 content)", () => {
    const codex = loadBundledDefaultCodex();
    expect(codex.drifts).toBeDefined();
    expect((codex.drifts ?? []).length).toBeGreaterThanOrEqual(4);
    expect(codex.workflows).toBeDefined();
    expect((codex.workflows ?? []).length).toBeGreaterThanOrEqual(1);
    expect(codex.default_workflow_id).toBe("standard-7-phase");
    expect(codex.claims).toBeDefined();
    expect((codex.claims ?? []).length).toBeGreaterThanOrEqual(5);
    expect(codex.policies).toBeDefined();
    expect((codex.policies ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("caches across calls (returns the same object instance on repeated calls)", () => {
    const first = loadBundledDefaultCodex();
    const second = loadBundledDefaultCodex();
    expect(first).toBe(second);
  });

  it("re-parses after __resetCachedCodexForTesting (fresh object instance)", () => {
    const first = loadBundledDefaultCodex();
    __resetCachedCodexForTesting();
    const second = loadBundledDefaultCodex();
    // Same content, different reference because cache was cleared.
    expect(first).not.toBe(second);
    expect(first.id).toBe(second.id);
  });

  it("exposes the standard-7-phase workflow with all 7 phases", () => {
    const codex = loadBundledDefaultCodex();
    const workflow = (codex.workflows ?? []).find((w) => w.id === "standard-7-phase");
    expect(workflow).toBeDefined();
    const phaseNames = (workflow?.phases ?? []).map((p) => p.name);
    expect(phaseNames).toEqual([
      "pre_research",
      "learn",
      "code",
      "test",
      "audit",
      "post_research",
      "fix",
    ]);
    // `fix` is the only soft phase (required: false). The other 6 are required.
    const requiredPhases = (workflow?.phases ?? []).filter((p) => p.required).map((p) => p.name);
    expect(requiredPhases).toEqual([
      "pre_research",
      "learn",
      "code",
      "test",
      "audit",
      "post_research",
    ]);
  });

  it("exposes versioning-pre1-patch-only policy with allowed_slots = [patch]", () => {
    const codex = loadBundledDefaultCodex();
    const policy = (codex.policies ?? []).find((p) => p.id === "versioning-pre1-patch-only");
    expect(policy).toBeDefined();
    if (policy?.kind === "versioning") {
      expect(policy.params.per_commit_required).toBe(true);
      expect(policy.params.allowed_slots).toEqual(["patch"]);
    } else {
      throw new Error("versioning-pre1-patch-only policy is not of kind=versioning");
    }
  });
});

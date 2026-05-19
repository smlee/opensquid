/**
 * Verifies that the bundled-default codex round-trips through the
 * codex parser. Acts as both a fixture test (proves the schema
 * additions actually parse) and a CI tripwire (any drift between
 * codex YAML + zod schema fails here first).
 *
 * Part of drift-as-codex chunk 1 (#146).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCodexYaml } from "../parse.js";
import { isFocusedCodex } from "../types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DEFAULT_PATH = path.join(HERE, "codex.yaml");

describe("bundled-default codex", () => {
  it("parses without errors", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    expect(() => parseCodexYaml(yaml)).not.toThrow();
  });

  it("is a focused codex with the expected id + version", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    expect(isFocusedCodex(c)).toBe(true);
    if (!isFocusedCodex(c)) return;
    expect(c.id).toBe("opensquid-default");
    expect(c.version).toBe("1.0.0");
  });

  it("declares the four standard drifts (never-amend / no-implicit-push / substrate-purity / no-force-push-main)", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    if (!isFocusedCodex(c)) throw new Error("expected focused codex");
    const ids = (c.drifts ?? []).map((d) => d.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "never-amend",
        "no-implicit-push",
        "substrate-purity",
        "no-force-push-main",
      ]),
    );
  });

  it("declares the standard-7-phase workflow with all 7 phases", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    if (!isFocusedCodex(c)) throw new Error("expected focused codex");
    const wf = (c.workflows ?? []).find((w) => w.id === "standard-7-phase");
    expect(wf).toBeDefined();
    expect(wf?.phases.map((p) => p.name)).toEqual([
      "pre_research",
      "learn",
      "code",
      "test",
      "audit",
      "post_research",
      "fix",
    ]);
    expect(c.default_workflow_id).toBe("standard-7-phase");
  });

  it("marks `fix` phase as optional (skip-with-reason allowed)", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    if (!isFocusedCodex(c)) throw new Error("expected focused codex");
    const wf = (c.workflows ?? []).find((w) => w.id === "standard-7-phase");
    const fixPhase = wf?.phases.find((p) => p.name === "fix");
    expect(fixPhase?.required).toBe(false);
  });

  it("declares the PATCH-ONLY pre-1.0 versioning policy", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    if (!isFocusedCodex(c)) throw new Error("expected focused codex");
    const versioning = (c.policies ?? []).find((p) => p.kind === "versioning");
    expect(versioning).toBeDefined();
    if (versioning?.kind !== "versioning") return;
    expect(versioning.params.allowed_slots).toEqual(["patch"]);
    expect(versioning.params.per_commit_required).toBe(true);
    expect(versioning.params.slot_for?.bug_fix).toBe("patch");
    expect(versioning.params.slot_for?.feature).toBe("patch");
    expect(versioning.params.slot_for?.breaking).toBe("patch");
  });

  it("declares a phase_logged policy that references the standard workflow", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    if (!isFocusedCodex(c)) throw new Error("expected focused codex");
    const phasePolicy = (c.policies ?? []).find((p) => p.kind === "phase_logged");
    expect(phasePolicy).toBeDefined();
    if (phasePolicy?.kind !== "phase_logged") return;
    expect(phasePolicy.params.workflow_id).toBe("standard-7-phase");
    expect(phasePolicy.params.enforce_on).toContain("git_commit");
  });

  it("ports the five load-bearing honesty-ledger claims", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    if (!isFocusedCodex(c)) throw new Error("expected focused codex");
    const ids = (c.claims ?? []).map((cl) => cl.id);
    expect(ids).toEqual(
      expect.arrayContaining(["telegram-sent", "pushed", "tagged", "phase-logged", "fmt-clippy"]),
    );
  });

  it("uses any_of evidence for the telegram-sent claim (proves recursive schema works)", async () => {
    const yaml = await fs.readFile(BUNDLED_DEFAULT_PATH, "utf8");
    const c = parseCodexYaml(yaml);
    if (!isFocusedCodex(c)) throw new Error("expected focused codex");
    const telegramSent = (c.claims ?? []).find((cl) => cl.id === "telegram-sent");
    expect(telegramSent?.evidence.kind).toBe("any_of");
    if (telegramSent?.evidence.kind !== "any_of") return;
    expect(telegramSent.evidence.options.length).toBeGreaterThanOrEqual(2);
  });
});

describe("FocusedCodex schema — drift-as-codex additions (chunk 1)", () => {
  it("accepts a codex with no drift-as-codex sections (backward compat)", () => {
    const c = parseCodexYaml(`id: legacy\nversion: "1.0.0"\n`);
    expect(isFocusedCodex(c)).toBe(true);
  });

  it("rejects a drift entry with an unknown severity", () => {
    const bad = `
id: bad
version: "1.0.0"
drifts:
  - id: x
    tool: Bash
    trigger: { kind: bash_regex, pattern: "foo" }
    lesson: y
    severity: maybe
    message: hi
`;
    expect(() => parseCodexYaml(bad)).toThrow();
  });

  it("rejects a workflow with zero phases", () => {
    const bad = `
id: bad
version: "1.0.0"
workflows:
  - id: empty
    enforce_on: [git_commit]
    phases: []
`;
    expect(() => parseCodexYaml(bad)).toThrow();
  });

  it("rejects a versioning policy with empty allowed_slots", () => {
    const bad = `
id: bad
version: "1.0.0"
policies:
  - id: bad-pol
    kind: versioning
    params:
      per_commit_required: true
      allowed_slots: []
`;
    expect(() => parseCodexYaml(bad)).toThrow();
  });
});

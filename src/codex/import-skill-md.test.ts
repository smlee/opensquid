import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SkillMdImportError,
  convertSkillMdToCodex,
  detectVariant,
  parseSkillMd,
  slugify,
} from "./import-skill-md.js";
import { isFocusedCodex } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../../test/fixtures/skill-md");

async function loadFixture(name: string): Promise<string> {
  return fs.readFile(path.join(FIXTURES, name), "utf8");
}

// ---------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases ASCII", () => {
    expect(slugify("HelloWorld")).toBe("helloworld");
  });
  it("replaces underscores with dashes", () => {
    expect(slugify("google_meet")).toBe("google-meet");
  });
  it("collapses runs of non-alphanumerics", () => {
    expect(slugify("foo  bar___baz")).toBe("foo-bar-baz");
  });
  it("trims leading/trailing dashes", () => {
    expect(slugify("---foo---")).toBe("foo");
  });
  it("caps at 64 chars", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBe(64);
  });
  it("throws on empty after stripping", () => {
    expect(() => slugify("!!!")).toThrow(SkillMdImportError);
  });
});

// ---------------------------------------------------------------------
// parseSkillMd
// ---------------------------------------------------------------------

describe("parseSkillMd", () => {
  it("rejects empty input", () => {
    expect(() => parseSkillMd("")).toThrow(/empty/);
  });
  it("rejects missing frontmatter", () => {
    expect(() => parseSkillMd("just a body, no fences")).toThrow(/frontmatter/);
  });
  it("rejects missing name", () => {
    expect(() => parseSkillMd("---\ndescription: x\n---\nbody")).toThrow(/name/);
  });
  it("rejects missing description", () => {
    expect(() => parseSkillMd("---\nname: foo\n---\nbody")).toThrow(/description/);
  });
  it("parses minimal valid SKILL.md", () => {
    const { frontmatter, body } = parseSkillMd("---\nname: foo\ndescription: bar\n---\nhello");
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("bar");
    expect(body).toBe("hello");
  });
  it("handles CRLF line endings", () => {
    const { frontmatter } = parseSkillMd("---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody\r\n");
    expect(frontmatter.name).toBe("foo");
  });
});

// ---------------------------------------------------------------------
// detectVariant
// ---------------------------------------------------------------------

describe("detectVariant", () => {
  it("detects ECC by origin", () => {
    expect(detectVariant({ name: "x", description: "y", origin: "ECC" })).toBe("ecc");
  });
  it("detects Hermes by platforms array", () => {
    expect(detectVariant({ name: "x", description: "y", platforms: ["claude-code"] })).toBe(
      "hermes",
    );
  });
  it("detects Hermes by metadata.hermes block", () => {
    expect(detectVariant({ name: "x", description: "y", metadata: { hermes: { tags: [] } } })).toBe(
      "hermes",
    );
  });
  it("detects superpowers by path", () => {
    expect(
      detectVariant({ name: "x", description: "y" }, "/repo/superpowers/skills/foo/SKILL.md"),
    ).toBe("superpowers");
  });
  it("does NOT detect superpowers from CSO description alone (Anthropic skills use it too)", () => {
    expect(detectVariant({ name: "x", description: "Use when writing tests" })).toBe("anthropic");
  });
  it("detects pure Anthropic (only known fields)", () => {
    expect(detectVariant({ name: "x", description: "extracts text", license: "MIT" })).toBe(
      "anthropic",
    );
  });
  it("falls back to unknown for unrecognized non-standard fields", () => {
    expect(detectVariant({ name: "x", description: "extracts text", randomField: 1 })).toBe(
      "unknown",
    );
  });
});

// ---------------------------------------------------------------------
// convertSkillMdToCodex — fixture round-trip
// ---------------------------------------------------------------------

describe("convertSkillMdToCodex — fixtures", () => {
  it("converts Anthropic skill-creator (minimal)", async () => {
    const raw = await loadFixture("anthropic-skill-creator.md");
    const { codex, lessons, variant } = convertSkillMdToCodex(raw, {
      originalPath: "/fake/skill-creator/SKILL.md",
      now: "2026-05-16T00:00:00.000Z",
    });
    expect(variant).toBe("anthropic");
    expect(codex.id).toBe("skill-creator");
    expect(codex.version).toBe("1.0.0");
    expect(isFocusedCodex(codex)).toBe(true);
    if (!isFocusedCodex(codex)) throw new Error("unreachable");
    expect(codex.evolves).toBe(true);
    expect(codex.source?.kind).toBe("skill_md");
    expect(codex.source?.original_variant).toBe("anthropic");
    expect(codex.source?.original_name).toBe("skill-creator");
    expect(codex.source?.imported_at).toBe("2026-05-16T00:00:00.000Z");
    expect(codex.metadata?.imported_from).toBe("skill_md");
    expect(codex.metadata?.imported).toEqual({ synthesized_version: true });
    expect(codex.seed_lessons).toHaveLength(1);
    expect(codex.seed_lessons?.[0]?.id).toBe("skill-creator");
    expect(codex.seed_lessons?.[0]?.body_path).toBe("lessons/skill-creator/lesson.md");
    expect(lessons).toHaveLength(1);
    expect(lessons[0].body).toContain("# Skill Creator");
  });

  it("converts Anthropic pdf — preserves license", async () => {
    const raw = await loadFixture("anthropic-pdf.md");
    const { codex } = convertSkillMdToCodex(raw, { originalPath: "/fake/pdf/SKILL.md" });
    expect(codex.id).toBe("pdf");
    expect(codex.license).toBe("Apache-2.0");
  });

  it("converts superpowers TDD — path-based detection", async () => {
    const raw = await loadFixture("superpowers-tdd.md");
    const { codex, variant } = convertSkillMdToCodex(raw, {
      originalPath: "/home/u/repos/superpowers/skills/test-driven-development/SKILL.md",
    });
    expect(variant).toBe("superpowers");
    expect(codex.id).toBe("test-driven-development");
  });

  it("converts ECC tdd-workflow — preserves origin in metadata", async () => {
    const raw = await loadFixture("ecc-tdd-workflow.md");
    const { codex, variant } = convertSkillMdToCodex(raw, {
      originalPath: "/fake/ecc/SKILL.md",
    });
    expect(variant).toBe("ecc");
    expect(codex.metadata?.origin).toBe("ECC");
  });

  it("converts Hermes dogfood — preserves version + author + extensions", async () => {
    const raw = await loadFixture("hermes-dogfood.md");
    const { codex, variant } = convertSkillMdToCodex(raw, {
      originalPath: "/fake/hermes/dogfood/SKILL.md",
    });
    expect(variant).toBe("hermes");
    if (!isFocusedCodex(codex)) throw new Error("unreachable");
    expect(codex.version).toBe("0.3.1");
    expect(codex.author?.name).toBe("Hermes Team");
    expect(codex.metadata?.platforms).toEqual(["claude-code", "cursor", "hermes"]);
    const hermesMeta = codex.metadata?.hermes as { tags?: string[]; related_skills?: string[] };
    expect(hermesMeta?.tags).toContain("testing");
    expect(hermesMeta?.related_skills).toContain("publish-skill");
    // synthesized_version marker MUST NOT be set when Hermes supplied a version
    expect(codex.metadata?.imported).toBeUndefined();
  });

  it("converts Hermes google_meet — underscore rewrites to hyphen", async () => {
    const raw = await loadFixture("hermes-google-meet.md");
    const { codex } = convertSkillMdToCodex(raw, {
      originalPath: "/fake/hermes/google_meet/SKILL.md",
    });
    expect(codex.id).toBe("google-meet");
    if (!isFocusedCodex(codex)) throw new Error("unreachable");
    expect(codex.source?.original_name).toBe("google_meet");
    expect(codex.seed_lessons?.[0]?.body_path).toBe("lessons/google-meet/lesson.md");
  });
});

// ---------------------------------------------------------------------
// allowed-tools mapping (Anthropic experimental field)
// ---------------------------------------------------------------------

describe("convertSkillMdToCodex — allowed-tools", () => {
  it("maps `allowed-tools` array to foundation.tools[]", () => {
    const src = `---
name: tooled
description: uses specific tools
allowed-tools:
  - Read
  - Bash
  - Edit
---

body`;
    const { codex } = convertSkillMdToCodex(src);
    if (!isFocusedCodex(codex)) throw new Error("unreachable");
    expect(codex.foundation?.tools?.map((t) => t.name)).toEqual(["Read", "Bash", "Edit"]);
  });

  it("omits foundation when allowed-tools is empty", () => {
    const src = `---
name: untooled
description: no tool restrictions
---

body`;
    const { codex } = convertSkillMdToCodex(src);
    if (!isFocusedCodex(codex)) throw new Error("unreachable");
    expect(codex.foundation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Unknown frontmatter keys → metadata catch-all
// ---------------------------------------------------------------------

describe("convertSkillMdToCodex — extensibility bucket", () => {
  it("preserves unknown top-level keys under metadata", () => {
    const src = `---
name: custom
description: has random fields
custom_field: hello
another: 42
---

body`;
    const { codex } = convertSkillMdToCodex(src);
    expect(codex.metadata?.custom_field).toBe("hello");
    expect(codex.metadata?.another).toBe(42);
  });
});

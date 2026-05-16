/**
 * SKILL.md → opensquid native codex converter (v0.6d).
 *
 * Pure functions. No filesystem side effects. Takes a raw SKILL.md
 * string + optional path metadata, returns a `{codex, lesson}` pair
 * that the install pipeline materializes to disk before calling the
 * existing `installCodex` + `copyCodexContent` path.
 *
 * Handles the union of:
 * - Anthropic skills (https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — `name`, `description`, optional `license`, optional experimental `allowed-tools` / `model` / `compatibility`
 * - obra/superpowers — strict Anthropic subset (name + description, CSO description discipline)
 * - everything-claude-code (ECC) — Anthropic + non-standard `origin: ECC`
 * - Hermes Agent skills (~/projects/hermes-agent/skills/) — Anthropic + `version` + `author` + `platforms` + `metadata.hermes.{tags, related_skills}`
 *
 * 100% deterministic. No LLM call. Per [[find-simple-solutions]]:
 * frontmatter → codex.yaml is structural mapping; body → one lesson is
 * the trivial 1:1 case that every sampled SKILL.md follows. Sub-skill
 * body-splitting is deferred until a real corpus demands it.
 */

import { parse as parseYaml } from "yaml";

import type { Codex, CodexSeedLesson, CodexSource, CodexTool, FocusedCodex } from "./types.js";

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export type SkillMdVariant = NonNullable<CodexSource["original_variant"]>;

export interface SkillMdParseResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ConvertOptions {
  /** Absolute path to the source SKILL.md (or its containing dir). */
  originalPath?: string;
  /** Wall-clock at conversion time. Defaults to `new Date().toISOString()`. */
  now?: string;
}

export interface ConvertedLesson {
  /** Lesson id (slug). */
  id: string;
  /** Path relative to the codex root — written via `lessons/<id>/lesson.md`. */
  bodyPath: string;
  /** Raw markdown body to write at `bodyPath`. */
  body: string;
}

export interface ConvertedCodex {
  codex: Codex;
  lessons: ConvertedLesson[];
  variant: SkillMdVariant;
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class SkillMdImportError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "SkillMdImportError";
  }
}

// ---------------------------------------------------------------------
// Parse SKILL.md frontmatter + body
// ---------------------------------------------------------------------

const FRONTMATTER_FENCE_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMd(source: string): SkillMdParseResult {
  if (!source || !source.trim()) {
    throw new SkillMdImportError(
      "SKILL.md is empty",
      "SKILL.md must have a YAML frontmatter block + body",
    );
  }
  // v0.6d audit fix (L1): strip UTF-8 BOM if present. The fence regex
  // requires `---` at the very start; a BOM-prefixed file (common from
  // Windows editors) would silently fail the match.
  const stripped = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = stripped.match(FRONTMATTER_FENCE_RE);
  if (!match) {
    throw new SkillMdImportError(
      "SKILL.md missing YAML frontmatter (--- ... ---) at top",
      "wrap your frontmatter in triple-dash fences and ensure the closing fence is on its own line",
    );
  }
  const [, yamlText, bodyText] = match;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (e) {
    throw new SkillMdImportError(
      `SKILL.md frontmatter is not valid YAML: ${e instanceof Error ? e.message : String(e)}`,
      "frontmatter must be parseable as YAML (key: value pairs)",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SkillMdImportError("SKILL.md frontmatter must be a YAML mapping (key: value pairs)");
  }
  const frontmatter = parsed as Record<string, unknown>;
  if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) {
    throw new SkillMdImportError(
      "SKILL.md frontmatter missing required `name` field",
      "per the Anthropic spec, `name` is required (max 64 chars, [a-z0-9-])",
    );
  }
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
    throw new SkillMdImportError(
      "SKILL.md frontmatter missing required `description` field",
      "per the Anthropic spec, `description` is required (max 1024 chars)",
    );
  }
  return { frontmatter, body: (bodyText ?? "").trim() };
}

// ---------------------------------------------------------------------
// Slugify (ASCII-safe — sampled SKILL.md names are all ASCII)
// ---------------------------------------------------------------------

const SLUG_MAX_LEN = 64;

export function slugify(name: string): string {
  const lower = name.toLowerCase();
  // Replace any run of non-alphanumerics with a single dash. Trim
  // leading/trailing dashes. Cap length per Anthropic spec.
  const dashed = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!dashed) {
    throw new SkillMdImportError(
      `cannot slugify name "${name}" (no alphanumeric characters)`,
      "skill names must include at least one ASCII letter or digit",
    );
  }
  return dashed.slice(0, SLUG_MAX_LEN);
}

// ---------------------------------------------------------------------
// Variant detection
// ---------------------------------------------------------------------

export function detectVariant(
  frontmatter: Record<string, unknown>,
  originalPath?: string,
): SkillMdVariant {
  if (frontmatter.origin === "ECC") return "ecc";
  // Hermes: rich frontmatter (`platforms`, `metadata.hermes.*`)
  if (Array.isArray(frontmatter.platforms)) return "hermes";
  const meta = frontmatter.metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    if ((meta as Record<string, unknown>).hermes !== undefined) return "hermes";
  }
  // superpowers: path-based detection only. The CSO "Use when..." phrasing
  // is recommended by superpowers but Anthropic's own skill-creator also
  // uses it, so description alone is too noisy to distinguish.
  const path = (originalPath ?? "").toLowerCase();
  if (path.includes("superpowers/skills/") || path.includes("/superpowers/")) {
    return "superpowers";
  }
  // Pure Anthropic minimum: only name + description (+ optional license)
  const keys = new Set(Object.keys(frontmatter));
  const anthropicKnown = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
    "model",
  ]);
  const allKnown = [...keys].every((k) => anthropicKnown.has(k));
  if (allKnown) return "anthropic";
  return "unknown";
}

// ---------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------

export function convertSkillMdToCodex(
  source: string,
  options: ConvertOptions = {},
): ConvertedCodex {
  const { frontmatter, body } = parseSkillMd(source);

  const rawName = (frontmatter.name as string).trim();
  const id = slugify(rawName);
  const description = (frontmatter.description as string).trim();
  const variant = detectVariant(frontmatter, options.originalPath);
  const now = options.now ?? new Date().toISOString();

  // ----- version: Hermes provides one; default to "1.0.0" otherwise -----
  let version = "1.0.0";
  let versionSynthesized = true;
  if (typeof frontmatter.version === "string" && frontmatter.version.trim()) {
    version = frontmatter.version.trim();
    versionSynthesized = false;
  }

  // ----- author: Hermes "author" is a flat string; opensquid wants {name, contact?} -----
  let author: FocusedCodex["author"] | undefined;
  const rawAuthor = frontmatter.author;
  if (typeof rawAuthor === "string" && rawAuthor.trim()) {
    author = { name: rawAuthor.trim() };
  } else {
    author = { name: "Imported from SKILL.md" };
  }

  // ----- license: pass through if present -----
  const license =
    typeof frontmatter.license === "string" && frontmatter.license.trim()
      ? frontmatter.license.trim()
      : undefined;

  // ----- foundation.tools from Anthropic experimental `allowed-tools` -----
  let tools: CodexTool[] | undefined;
  const allowedTools = frontmatter["allowed-tools"];
  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    tools = [];
    for (const t of allowedTools) {
      if (typeof t === "string" && t.trim()) {
        tools.push({ name: t.trim() });
      }
    }
    if (tools.length === 0) tools = undefined;
  }

  // ----- preserved non-standard frontmatter → metadata extensibility bucket -----
  const metadata: Record<string, unknown> = { imported_from: "skill_md" };
  if (versionSynthesized) {
    // mark for downstream auditing
    metadata.imported = { synthesized_version: true };
  }
  // Preserve every frontmatter key we don't have a first-class slot for.
  for (const [k, v] of Object.entries(frontmatter)) {
    if (
      k === "name" ||
      k === "description" ||
      k === "version" ||
      k === "author" ||
      k === "license" ||
      k === "allowed-tools"
    ) {
      continue;
    }
    // Anthropic optional `model` → metadata.model. Hermes `platforms` →
    // metadata.platforms. ECC `origin` → metadata.origin. Hermes
    // `metadata.hermes.*` is already a nested object; preserve it under
    // metadata.hermes (don't flatten).
    if (k === "metadata" && v && typeof v === "object" && !Array.isArray(v)) {
      // Merge into our metadata bucket without overwriting our own keys.
      for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
        if (!(mk in metadata)) {
          metadata[mk] = mv;
        }
      }
      continue;
    }
    metadata[k] = v;
  }

  // ----- source provenance -----
  const sourceBlock: CodexSource = {
    kind: "skill_md",
    original_variant: variant,
    original_name: rawName,
    original_path: options.originalPath,
    imported_at: now,
  };

  // ----- seed lesson (one cohesive lesson per SKILL.md) -----
  // The lesson trigger is the description verbatim — lossy in tone but
  // functionally correct. Future LLM-mediated trigger synthesis (deferred)
  // could rewrite into the imperative voice opensquid prefers.
  const seedLesson: CodexSeedLesson = {
    id,
    trigger: description,
    priority: "medium",
    bank_strategy: "full",
    body_path: `lessons/${id}/lesson.md`,
  };

  // Lesson body = the SKILL.md body verbatim. If empty (extremely rare —
  // would mean a frontmatter-only file), synthesize a stub.
  const lessonBody =
    body.length > 0
      ? body
      : `# ${rawName}\n\n${description}\n\n*(Imported from SKILL.md with no body content.)*\n`;

  const codex: FocusedCodex = {
    id,
    version,
    description,
    author,
    license,
    source: sourceBlock,
    metadata,
    kind: "focused",
    foundation: tools ? { tools } : undefined,
    seed_lessons: [seedLesson],
    evolves: true,
  };

  return {
    codex,
    lessons: [{ id, bodyPath: seedLesson.body_path, body: lessonBody }],
    variant,
  };
}

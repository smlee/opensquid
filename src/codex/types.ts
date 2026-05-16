/**
 * Codex format — opensquid's native schema for living skill packs.
 *
 * A codex bundles seed lessons + memory templates + verify gates +
 * doc-fetch declarations + foundational identity. Engine knows nothing
 * about this format; it only sees the resulting lessons seeded via
 * `lesson.create` with `authored_by: Pack(<codex-id>)`.
 *
 * See:
 *   - /Users/slee/projects/loop/docs/opensquid-v0.6-design.md §4
 *   - /Users/slee/projects/loop/docs/engine-v1.1-substrate-design.md
 */

// ---------------------------------------------------------------------
// Foundational identity (3 universal dimensions, each optional)
// ---------------------------------------------------------------------

/** A tool / software / instrument / product the codex knows about. */
export interface CodexTool {
  name: string;
  /** SemVer range expression. Omit for unversioned tools. */
  semver?: string;
}

/**
 * Foundation declares what the codex is ABOUT (descriptive).
 *
 * Separate from `detected_by` which decides whether to ACTIVATE here.
 * The same `atomic-design` codex (methodology) plugs into React, Vue,
 * or Angular projects equally — its foundation is the methodology,
 * activation is per-project.
 *
 * Each dimension is optional. A focused codex can declare any subset.
 */
export interface CodexFoundation {
  /** Software, instruments, applications, products. */
  tools?: CodexTool[];
  /** Field of work / subject area (e.g. "single-cell-genomics"). */
  domains?: string[];
  /** Ways of working (e.g. "atomic-design", "IRAC"). */
  methodologies?: string[];
}

// ---------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------

/**
 * Where the codex naturally applies. Defaults to `project`.
 *
 * - `project` — activate when project signals match (per-cwd)
 * - `user` — activate globally for this user (no project signals needed)
 * - `hybrid` — needs both user-level AND project-level signals
 * - `team` — activate for declared team members
 * - `global` — always-on (rare; system-level only)
 */
export type CodexActivationScope = "project" | "user" | "hybrid" | "team" | "global";

/**
 * Detection signals — when should this codex activate.
 *
 * Filesystem kinds work for developers/scientists/designers/screenwriters.
 * Memory + conversation + user-pinned kinds cover non-filesystem roles
 * (lawyers, therapists, parents, athletes).
 */
export type CodexDetection =
  | { kind: "file_exists"; path: string }
  | { kind: "dir_exists"; path: string }
  | {
      kind: "file_match";
      path: string;
      matches: Record<string, unknown>;
    }
  | { kind: "file_glob"; pattern: string; min_count?: number }
  | { kind: "memory_match"; memory_kind: string; value: string }
  | { kind: "conversation_signal"; contains: string[] }
  | { kind: "user_pinned" }
  | { kind: "all_of"; conditions: CodexDetection[] }
  | { kind: "any_of"; conditions: CodexDetection[] };

// ---------------------------------------------------------------------
// Bank strategy (lazy-load eagerness, per-item)
// ---------------------------------------------------------------------

/**
 * How much of a seed lesson goes into the agent's working memory bank.
 *
 * - `full` — trigger + entire body embedded; fully eager
 * - `trigger_only` — only trigger string searchable; body via `get_memory`
 * - `summary` — LLM-generated summary in bank; full body lazy
 * - `none` — not in bank; only reachable via citation id lookup
 */
export type CodexBankStrategy = "full" | "trigger_only" | "summary" | "none";

// ---------------------------------------------------------------------
// Seed lessons
// ---------------------------------------------------------------------

/** Trigger condition (string form OR structured). */
export type CodexTrigger =
  | string
  | {
      /** Intent description ("before creating a component"). */
      intent: string;
      /** Prescriptive phrasing for engine wire format. */
      prescriptive_form?: string;
    };

export interface CodexSeedLesson {
  /** Stable id within the codex. */
  id: string;
  /** When the lesson applies (router intent). */
  trigger: CodexTrigger;
  /** Importance signal for orchestrator ranking. */
  priority?: "high" | "medium" | "low";
  /** Default: `full`. */
  bank_strategy?: CodexBankStrategy;
  /** Path to lesson markdown body, relative to codex root. */
  body_path: string;
  /** Optional evidence citations to memories the lesson cites. */
  citations?: string[];
}

// ---------------------------------------------------------------------
// Verify gates
// ---------------------------------------------------------------------

/** When the gate fires. */
export interface CodexVerifyTrigger {
  /** Match by tool call (e.g. "Write"). */
  tool_call?: string;
  /** Glob over target file path (e.g. "src/components/**\/*.tsx"). */
  file_pattern?: string;
  /** Or match by intent description. */
  intent?: string;
}

/** Free-form requirement payload — orchestrator interprets. */
export type CodexVerifyRequirement = Record<string, unknown>;

export interface CodexVerifyGate {
  id: string;
  before: CodexVerifyTrigger;
  require: CodexVerifyRequirement[];
}

// ---------------------------------------------------------------------
// Memory templates (run at install/onboarding)
// ---------------------------------------------------------------------

export interface CodexMemoryTemplate {
  /** Path or glob to scan. */
  scan: string;
  /** Field paths to extract from scanned file. */
  extract: string[];
  /** How to store extracted data as a memory. */
  memorize_as?: { kind: string; scope?: string };
}

// ---------------------------------------------------------------------
// Doc fetch (lazy by definition)
// ---------------------------------------------------------------------

export interface CodexDocFetch {
  trigger: string;
  url: string;
  /** Cache lifetime in days. */
  ttl_days?: number;
}

// ---------------------------------------------------------------------
// Reference docs (typically bank_strategy: none — on-disk only)
// ---------------------------------------------------------------------

export interface CodexReferenceDoc {
  path: string;
  bank_strategy?: CodexBankStrategy;
}

// ---------------------------------------------------------------------
// Two codex kinds (focused vs composite)
// ---------------------------------------------------------------------

/**
 * v0.6d — provenance metadata attached when a codex is imported from
 * a foreign format (SKILL.md from Anthropic skills / superpowers / ECC /
 * Hermes skill directories). Absent on natively-authored codexes.
 *
 * Purpose: lets `opensquid codex doctor` / `list` surface the import
 * lineage without scanning the body, and lets future exports note
 * "this was originally a SKILL.md from <variant>".
 */
export interface CodexSource {
  /** Format the codex was converted from. */
  kind: "skill_md" | "native";
  /**
   * Variant flavor when known. Detection heuristic in
   * import-skill-md.ts. Diagnostic only — does not change runtime
   * behavior.
   */
  original_variant?: "anthropic" | "superpowers" | "ecc" | "hermes" | "unknown";
  /** SKILL.md's original `name` frontmatter field (before slugify). */
  original_name?: string;
  /** Absolute path at import time (diagnostic). */
  original_path?: string;
  /** ISO 8601 timestamp the import ran. */
  imported_at?: string;
}

/** Common header fields shared by both kinds. */
interface CodexBaseHeader {
  id: string;
  version: string;
  author?: { name?: string; contact?: string };
  license?: string;
  description?: string;
  /** v0.6d: import provenance. Absent on natively-authored codexes. */
  source?: CodexSource;
  /**
   * v0.6d: extensibility bucket. Used by the SKILL.md importer to
   * preserve non-standard frontmatter fields (Hermes `platforms`,
   * `metadata.hermes.tags`, ECC `origin`, etc.) so round-trip
   * inspection is lossless. Natively-authored codexes can also use
   * this for ad-hoc tags.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Focused codex — the real unit of codex content. Has own foundation,
 * own seed lessons, own gates, etc. Activates by its own `detected_by`.
 */
export interface FocusedCodex extends CodexBaseHeader {
  kind?: "focused";
  foundation?: CodexFoundation;
  activation_scope?: CodexActivationScope;
  detected_by?: CodexDetection[];
  seed_lessons?: CodexSeedLesson[];
  verify_gates?: CodexVerifyGate[];
  memory_templates?: CodexMemoryTemplate[];
  doc_fetch?: CodexDocFetch[];
  reference_docs?: CodexReferenceDoc[];
  /** When true, engine refines this codex via gated lesson promotion. */
  evolves?: boolean;
}

/**
 * Composite codex — pure aggregator of focused codexes. NO own content
 * (no seed_lessons, no foundation, no gates). One-shot install of
 * multiple focused codexes as a unit.
 */
export interface CompositeCodex extends CodexBaseHeader {
  kind: "composite";
  includes: CodexInclude[];
}

export interface CodexInclude {
  id: string;
  semver: string;
}

/** Either codex kind. Discriminate via `kind` field (default focused). */
export type Codex = FocusedCodex | CompositeCodex;

// ---------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------

export function isCompositeCodex(c: Codex): c is CompositeCodex {
  return c.kind === "composite";
}

export function isFocusedCodex(c: Codex): c is FocusedCodex {
  return c.kind !== "composite";
}

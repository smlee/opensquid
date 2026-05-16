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
// Drift-as-codex sections (chunk 1, 0.7.3+)
// ---------------------------------------------------------------------
//
// Today's hardcoded drift gates (drift-patterns.ts, workflow-gate.ts,
// honesty-ledger.ts, versioning-gate.ts) move into codex YAML so users
// with different workflows don't have to fork the npm package. The
// loader (next chunk) reads the active project's codex + the bundled
// default + composes the live catalog. This chunk only adds the
// schema + a bundled-default codex; the hooks still use their
// hardcoded TS until the loader chunk lands.

/** Severity for drift / workflow / claim findings. */
export type CodexDriftSeverity = "block" | "warn";

/** Which tool a drift pattern matches against. */
export type CodexDriftToolMatch = "Bash" | "Edit" | "Write" | "*";

/** Drift pattern trigger — same shape as DriftTrigger in drift-patterns.ts. */
export type CodexDriftTrigger =
  | { kind: "bash_contains"; needle: string; strip_quotes?: boolean }
  | { kind: "bash_regex"; pattern: string; strip_quotes?: boolean }
  | { kind: "text_regex"; pattern: string; field: string };

/**
 * A drift pattern entry — port of DriftPattern (drift-patterns.ts:20).
 * The loader composes a catalog from all codex `drifts/` entries +
 * the bundled-default's entries.
 */
export interface CodexDriftEntry {
  id: string;
  tool: CodexDriftToolMatch;
  trigger: CodexDriftTrigger;
  /** Lesson id in the workflow codex that owns this rule. */
  lesson: string;
  /** Agent-facing explanation surfaced when triggered. */
  message: string;
  severity: CodexDriftSeverity;
}

/**
 * A single phase in a workflow. The `name` is the user's identifier
 * (e.g. "pre_research", "learn", "code", "test", "audit",
 * "post_research", "fix" for the locked 7-phase rule, or whatever
 * sequence another user prefers).
 */
export interface CodexWorkflowPhase {
  name: string;
  /**
   * When false, the phase may be skipped if the agent logs a
   * `skip` entry with a reason in the phase ledger. When true, the
   * workflow-gate refuses to allow the task's terminal action (commit,
   * push, etc.) without a non-skip phase entry.
   */
  required: boolean;
  /** Optional short description shown in error messages. */
  description?: string;
}

/**
 * Workflow definition — ordered phase sequence + which terminal action
 * triggers gate enforcement. Multiple workflows can be defined per
 * codex (e.g. one for "ship a feature", a shorter one for "ship a docs
 * fix"); active workflow is selected by `default_workflow_id` or by
 * an explicit `workflow_id` on the task.
 */
export interface CodexWorkflowEntry {
  id: string;
  phases: CodexWorkflowPhase[];
  /**
   * Tool calls that trigger the gate (e.g. ["git_commit", "git_push"]).
   * The loader maps these to PreToolUse hook triggers.
   */
  enforce_on: string[];
  description?: string;
}

/**
 * Evidence shape for a claim — what tool call (or call composition)
 * counts as fulfilling the claim. Mirrors honesty-ledger.ts evidence
 * kinds. `any_of` is recursive so claims like "telegram-sent" can
 * resolve via either of two MCP tools.
 */
export type CodexClaimEvidence =
  | { kind: "tool_call"; tool: string }
  | { kind: "bash_contains"; needle: string }
  | { kind: "bash_regex"; pattern: string }
  | { kind: "input_contains"; tool: string; field: string; needle: string }
  | { kind: "any_of"; options: CodexClaimEvidence[] };

/**
 * A claim pattern — port of HonestyLedger pattern shape. Loader
 * composes the active project's catalog + bundled-default.
 */
export interface CodexClaimEntry {
  id: string;
  /** Regex matched against assistant text since last user turn. */
  claim_pattern: string;
  /** Evidence shape that fulfills the claim. */
  evidence: CodexClaimEvidence;
  /** User-facing message when the claim is unfulfilled. */
  unfulfilled_message: string;
  severity: CodexDriftSeverity;
}

/**
 * A policy entry — declarative rules the versioning-gate / other
 * higher-level gates enforce. v1 ships two policy kinds:
 *
 *   - `versioning`: per-commit version bump policy (slot rules, etc.)
 *   - `phase_logged`: require N phases logged before a terminal action
 *
 * The `params` shape is per-policy-kind; loader narrows by `kind`.
 */
export type CodexPolicyEntry =
  | {
      id: string;
      kind: "versioning";
      params: CodexVersioningPolicy;
    }
  | {
      id: string;
      kind: "phase_logged";
      params: CodexPhaseLoggedPolicy;
    };

export interface CodexVersioningPolicy {
  /**
   * When true, any commit touching src/** must include a version-line
   * change in Cargo.toml / package.json. The existing versioning-gate
   * v0.6.3 behavior. Pre-1.0 PATCH-ONLY rule defaults this to true.
   */
  per_commit_required: boolean;
  /**
   * Which slot the agent may bump. Pre-1.0 PATCH-ONLY rule restricts
   * this to ["patch"]. A future stable codex may allow ["patch",
   * "minor"] etc.
   */
  allowed_slots: Array<"patch" | "minor" | "major">;
  /**
   * Optional finer-grained policy: for a given change type, which slot
   * is expected. Used by a future v0.8 lint-style check that detects
   * "diff looks like a feature, was bumped as patch → block".
   */
  slot_for?: {
    bug_fix?: "patch" | "minor" | "major";
    feature?: "patch" | "minor" | "major";
    breaking?: "patch" | "minor" | "major";
  };
}

export interface CodexPhaseLoggedPolicy {
  /** Workflow id whose phases must be logged. */
  workflow_id: string;
  /** Which terminal tool calls trigger this policy. */
  enforce_on: string[];
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
  /**
   * Drift-as-codex sections (0.7.3+, additive). Hooks consume these
   * via the loader (next chunk); existing codexes without them parse
   * unchanged.
   */
  drifts?: CodexDriftEntry[];
  workflows?: CodexWorkflowEntry[];
  default_workflow_id?: string;
  claims?: CodexClaimEntry[];
  policies?: CodexPolicyEntry[];
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

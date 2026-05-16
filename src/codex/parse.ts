/**
 * Codex YAML parsing + runtime validation.
 *
 * Authoritative parse for codex.yaml files. Used by `opensquid codex
 * install <path>` to validate before storing locally. Foreign-format
 * imports (superpowers SKILL.md, ECC, etc.) come pre-converted to
 * native codex YAML via LLM at install time — this parser sees the
 * native shape only.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type {
  Codex,
  CodexActivationScope,
  CodexBankStrategy,
  CodexClaimEntry,
  CodexClaimEvidence,
  CodexDetection,
  CodexDriftEntry,
  CodexDriftSeverity,
  CodexDriftToolMatch,
  CodexDriftTrigger,
  CodexPolicyEntry,
  CodexWorkflowEntry,
  CodexWorkflowPhase,
  CompositeCodex,
  FocusedCodex,
} from "./types.js";

// ---------------------------------------------------------------------
// Primitive schemas
// ---------------------------------------------------------------------

const CodexToolSchema = z.object({
  name: z.string().min(1),
  semver: z.string().optional(),
});

const CodexFoundationSchema = z.object({
  tools: z.array(CodexToolSchema).optional(),
  domains: z.array(z.string()).optional(),
  methodologies: z.array(z.string()).optional(),
});

const ActivationScopeSchema: z.ZodType<CodexActivationScope> = z.enum([
  "project",
  "user",
  "hybrid",
  "team",
  "global",
]);

const BankStrategySchema: z.ZodType<CodexBankStrategy> = z.enum([
  "full",
  "trigger_only",
  "summary",
  "none",
]);

// Detection — recursive type, defined via z.lazy()
const DetectionSchema: z.ZodType<CodexDetection> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file_exists"), path: z.string().min(1) }),
    z.object({ kind: z.literal("dir_exists"), path: z.string().min(1) }),
    z.object({
      kind: z.literal("file_match"),
      path: z.string().min(1),
      matches: z.record(z.string(), z.unknown()),
    }),
    z.object({
      kind: z.literal("file_glob"),
      pattern: z.string().min(1),
      min_count: z.number().int().nonnegative().optional(),
    }),
    z.object({
      kind: z.literal("memory_match"),
      memory_kind: z.string().min(1),
      value: z.string().min(1),
    }),
    z.object({
      kind: z.literal("conversation_signal"),
      contains: z.array(z.string()).min(1),
    }),
    z.object({ kind: z.literal("user_pinned") }),
    z.object({
      kind: z.literal("all_of"),
      conditions: z.array(DetectionSchema).min(1),
    }),
    z.object({
      kind: z.literal("any_of"),
      conditions: z.array(DetectionSchema).min(1),
    }),
  ]),
);

const TriggerSchema = z.union([
  z.string().min(1),
  z.object({
    intent: z.string().min(1),
    prescriptive_form: z.string().optional(),
  }),
]);

const SeedLessonSchema = z.object({
  id: z.string().min(1),
  trigger: TriggerSchema,
  priority: z.enum(["high", "medium", "low"]).optional(),
  bank_strategy: BankStrategySchema.optional(),
  body_path: z.string().min(1),
  citations: z.array(z.string()).optional(),
});

const VerifyGateSchema = z.object({
  id: z.string().min(1),
  before: z.object({
    tool_call: z.string().optional(),
    file_pattern: z.string().optional(),
    intent: z.string().optional(),
  }),
  require: z.array(z.record(z.string(), z.unknown())).min(1),
});

const MemoryTemplateSchema = z.object({
  scan: z.string().min(1),
  extract: z.array(z.string()).min(1),
  memorize_as: z
    .object({
      kind: z.string().min(1),
      scope: z.string().optional(),
    })
    .optional(),
});

const DocFetchSchema = z.object({
  trigger: z.string().min(1),
  url: z.string().url(),
  ttl_days: z.number().int().positive().optional(),
});

const ReferenceDocSchema = z.object({
  path: z.string().min(1),
  bank_strategy: BankStrategySchema.optional(),
});

// v0.6d: import provenance (set by the SKILL.md converter; absent on
// natively-authored codexes).
const SourceSchema = z.object({
  kind: z.enum(["skill_md", "native"]),
  original_variant: z.enum(["anthropic", "superpowers", "ecc", "hermes", "unknown"]).optional(),
  original_name: z.string().optional(),
  original_path: z.string().optional(),
  imported_at: z.string().optional(),
});

const HeaderSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  author: z
    .object({
      name: z.string().optional(),
      contact: z.string().optional(),
    })
    .optional(),
  license: z.string().optional(),
  description: z.string().optional(),
  // v0.6d: optional import provenance + extensibility bucket. Both
  // additive; pre-v0.6d codex.yaml files parse unchanged.
  source: SourceSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------
// Composite vs focused — discriminated by `kind` field
// ---------------------------------------------------------------------

const CompositeCodexSchema = HeaderSchema.extend({
  kind: z.literal("composite"),
  includes: z
    .array(
      z.object({
        id: z.string().min(1),
        semver: z.string().min(1),
      }),
    )
    .min(1),
});

// ---------------------------------------------------------------------
// Drift-as-codex section schemas (0.7.3+, additive)
// ---------------------------------------------------------------------

const DriftSeveritySchema: z.ZodType<CodexDriftSeverity> = z.enum(["block", "warn"]);

const DriftToolMatchSchema: z.ZodType<CodexDriftToolMatch> = z.enum(["Bash", "Edit", "Write", "*"]);

const DriftTriggerSchema: z.ZodType<CodexDriftTrigger> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bash_contains"),
    needle: z.string().min(1),
    strip_quotes: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("bash_regex"),
    pattern: z.string().min(1),
    strip_quotes: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("text_regex"),
    pattern: z.string().min(1),
    field: z.string().min(1),
  }),
]);

const DriftEntrySchema: z.ZodType<CodexDriftEntry> = z.object({
  id: z.string().min(1),
  tool: DriftToolMatchSchema,
  trigger: DriftTriggerSchema,
  lesson: z.string().min(1),
  message: z.string().min(1),
  severity: DriftSeveritySchema,
});

const WorkflowPhaseSchema: z.ZodType<CodexWorkflowPhase> = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  description: z.string().optional(),
});

const WorkflowEntrySchema: z.ZodType<CodexWorkflowEntry> = z.object({
  id: z.string().min(1),
  phases: z.array(WorkflowPhaseSchema).min(1),
  enforce_on: z.array(z.string().min(1)).min(1),
  description: z.string().optional(),
});

const ClaimEvidenceSchema: z.ZodType<CodexClaimEvidence> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tool_call"), tool: z.string().min(1) }),
    z.object({ kind: z.literal("bash_contains"), needle: z.string().min(1) }),
    z.object({ kind: z.literal("bash_regex"), pattern: z.string().min(1) }),
    z.object({
      kind: z.literal("input_contains"),
      tool: z.string().min(1),
      field: z.string().min(1),
      needle: z.string().min(1),
    }),
    z.object({ kind: z.literal("any_of"), options: z.array(ClaimEvidenceSchema).min(1) }),
  ]),
);

const ClaimEntrySchema: z.ZodType<CodexClaimEntry> = z.object({
  id: z.string().min(1),
  claim_pattern: z.string().min(1),
  evidence: ClaimEvidenceSchema,
  unfulfilled_message: z.string().min(1),
  severity: DriftSeveritySchema,
});

const VersioningPolicySchema = z.object({
  per_commit_required: z.boolean(),
  allowed_slots: z.array(z.enum(["patch", "minor", "major"])).min(1),
  slot_for: z
    .object({
      bug_fix: z.enum(["patch", "minor", "major"]).optional(),
      feature: z.enum(["patch", "minor", "major"]).optional(),
      breaking: z.enum(["patch", "minor", "major"]).optional(),
    })
    .optional(),
});

const PhaseLoggedPolicySchema = z.object({
  workflow_id: z.string().min(1),
  enforce_on: z.array(z.string().min(1)).min(1),
});

const PolicyEntrySchema: z.ZodType<CodexPolicyEntry> = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("versioning"),
    params: VersioningPolicySchema,
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("phase_logged"),
    params: PhaseLoggedPolicySchema,
  }),
]);

const FocusedCodexSchema = HeaderSchema.extend({
  kind: z.literal("focused").optional(),
  foundation: CodexFoundationSchema.optional(),
  activation_scope: ActivationScopeSchema.optional(),
  detected_by: z.array(DetectionSchema).optional(),
  seed_lessons: z.array(SeedLessonSchema).optional(),
  verify_gates: z.array(VerifyGateSchema).optional(),
  memory_templates: z.array(MemoryTemplateSchema).optional(),
  doc_fetch: z.array(DocFetchSchema).optional(),
  reference_docs: z.array(ReferenceDocSchema).optional(),
  drifts: z.array(DriftEntrySchema).optional(),
  workflows: z.array(WorkflowEntrySchema).optional(),
  default_workflow_id: z.string().min(1).optional(),
  claims: z.array(ClaimEntrySchema).optional(),
  policies: z.array(PolicyEntrySchema).optional(),
  evolves: z.boolean().optional(),
});

const CodexSchema = z.union([CompositeCodexSchema, FocusedCodexSchema]);

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class CodexParseError extends Error {
  constructor(
    message: string,
    public readonly issues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = "CodexParseError";
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Parse + validate a codex from a raw object (already-parsed YAML/JSON).
 *
 * Throws `CodexParseError` on schema violations with detailed issues.
 */
export function parseCodex(raw: unknown): Codex {
  const result = CodexSchema.safeParse(raw);
  if (!result.success) {
    throw new CodexParseError(
      `codex validation failed: ${result.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
      result.error.issues,
    );
  }
  // safeParse with z.union returns one of the union branches — narrow.
  const parsed = result.data;
  if (parsed.kind === "composite") {
    return parsed as CompositeCodex;
  }
  return parsed as FocusedCodex;
}

/**
 * Parse a codex from a YAML string.
 *
 * Throws `CodexParseError` on YAML syntax error or schema violation.
 */
export function parseCodexYaml(source: string): Codex {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new CodexParseError(
      `codex YAML syntax error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object") {
    throw new CodexParseError(
      `codex YAML must be a top-level object, got ${raw === null ? "null" : typeof raw}`,
    );
  }
  return parseCodex(raw);
}

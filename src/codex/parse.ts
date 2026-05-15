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
  CodexDetection,
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

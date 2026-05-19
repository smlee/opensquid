/**
 * Zod schema for `skill.yaml` — one skill's definition inside a pack.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Skill format" +
 * §"Skill properties" + memory `project_opensquid_modular_function_skill_separation`
 * + `project_opensquid_codex_load_hybrid`.
 *
 * A skill is a unit of work-discipline that loads + unloads dynamically based
 * on declared conditions. Rules inside the skill express checks as PROCESSES
 * — compositions of primitive function calls — not as enumerated typed unions.
 * This keeps the schema small while staying expressive.
 *
 * NOT `.strict()`: skills are extended over time (Phase 3 refines
 * `when_to_load` matchers; future phases may add fields). We accept extra keys
 * at load time and let higher layers (rule evaluator, matcher) decide whether
 * an unknown field is meaningful or noise. Manifest is the only file where
 * `.strict()` makes sense — pack identity must not silently typo.
 *
 * `when_to_load` is refined to a `Matcher` discriminated union (Phase 3 Task
 * 3.1) and `unloads_when` to an `UnloadCondition` discriminated union (Phase
 * 3 Task 3.2). Pack authors can use shorthand forms — single-key objects
 * (`- tool_match: Bash`) and bare strings (`- session_ends`) — the schemas'
 * preprocess hooks normalize both to canonical discriminated form.
 *
 * Imports from: zod, ../../runtime/load_matchers, ../../runtime/unload_conditions.
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

import { Matcher } from '../../runtime/load_matchers.js';
import { UnloadCondition } from '../../runtime/unload_conditions.js';

// ---------------------------------------------------------------------------
// ProcessStep — one step inside a rule's process.
//
// `call` — the primitive function name (regex_match, llm_classify, verdict,
//          recall, store_lesson, etc.).
// `args` — opaque key-value bag; per-primitive Zod refinement lands in the
//          function-library registry (separate from this YAML schema).
// `as`   — variable binding for downstream steps (`as: hit` then `if: hit`).
// `if`   — conditional execution expression (evaluator-interpreted).
// `on_empty` — what verdict to emit when the call produces no output.
// ---------------------------------------------------------------------------

export const ProcessStep = z.object({
  call: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  as: z.string().optional(),
  if: z.string().optional(),
  on_empty: z.enum(['pass', 'block', 'continue']).optional(),
});
export type ProcessStep = z.infer<typeof ProcessStep>;

// ---------------------------------------------------------------------------
// RuleKindEnum — two anti-drift flavors per design doc §"Anti-drift split".
//
// `track_check`       — deterministic workflow rule (regex, count, sequence).
// `destination_check` — LLM-judged goal-alignment check via model alias.
// Default: track_check (the more common case).
// ---------------------------------------------------------------------------

export const RuleKindEnum = z.enum(['track_check', 'destination_check']);
export type RuleKindEnum = z.infer<typeof RuleKindEnum>;

// ---------------------------------------------------------------------------
// Rule — one process inside a skill.
//
// `interval` — when a rule is periodic rather than per-event. The runtime
// evaluator (Task 1.5) reads this and gates execution accordingly. Optional
// because most rules run on every triggering event.
// ---------------------------------------------------------------------------

export const Rule = z.object({
  id: z.string().min(1),
  kind: RuleKindEnum.default('track_check'),
  process: z.array(ProcessStep).min(1),
  interval: z.object({ every_n_tool_calls: z.number().int().positive() }).optional(),
});
export type Rule = z.infer<typeof Rule>;

// ---------------------------------------------------------------------------
// LoadModeEnum — preload vs lazy per design doc §"Skill properties".
//
// `preload` — loaded at session start, stays loaded (always-active discipline).
// `lazy`    — loaded when `when_to_load` fires; unloaded per `unloads_when`.
// Default: lazy (context-minimization preference per
// `project_opensquid_reduced_context_first_principle`).
// ---------------------------------------------------------------------------

export const LoadModeEnum = z.enum(['preload', 'lazy']);
export type LoadModeEnum = z.infer<typeof LoadModeEnum>;

// ---------------------------------------------------------------------------
// Skill — one skill's full definition.
//
// `tools` — bundled skill-internal scripts/check-functions (NOT MCP tools).
// `prose` — optional LLM-facing guidance loaded only when the skill is active.
// ---------------------------------------------------------------------------

export const Skill = z.object({
  name: z.string().min(1),
  load: LoadModeEnum.default('lazy'),
  when_to_load: z.array(Matcher).default([]),
  unloads_when: z.array(UnloadCondition).default([]),
  rules: z.array(Rule).default([]),
  tools: z.array(z.string()).default([]),
  prose: z.string().optional(),
});
export type Skill = z.infer<typeof Skill>;

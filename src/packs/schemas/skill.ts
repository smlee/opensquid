/**
 * Zod schema for `skill.yaml` — one skill's definition inside a pack.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Skill format" +
 * §"Skill properties" + memory `project_opensquid_modular_function_skill_separation`
 * + `project_opensquid_pack_load_hybrid`.
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

import { parseExpression } from '../../runtime/evaluator/expression/index.js';
import { Matcher } from '../../runtime/load_matchers.js';
import { SkillRequires } from '../../runtime/skill_requires.js';
import { EventKind, Trigger, defaultTriggers } from '../../runtime/types.js';
import { UnloadCondition } from '../../runtime/unload_conditions.js';

// ---------------------------------------------------------------------------
// conditionString — load-time-validated `if:` expression (Task H.2).
//
// Wraps `z.string()` with a `.refine()` that parses the expression through
// `parseExpression` (chevrotain lexer + parser + AST visitor from H.1). A
// pack with an unparseable `if:` clause now fails fast at `loadPack()` with
// full source-path + Zod field-path context — was previously a silent
// `false` + `console.warn` at first event fire.
//
// Empty / whitespace-only strings are accepted at load time (return true)
// to match the runtime's §12.2 semantics in
// `src/runtime/evaluator/expression/index.ts:82` — a present-but-empty
// `if:` is equivalent to "no `if:` field" so trailing-whitespace YAML
// doesn't accidentally skip steps. The `parseExpression` entry itself
// throws on empties (it's the parse-only sibling — see its JSDoc); we
// short-circuit before calling it.
//
// Error threading: `parseYamlFile` (src/packs/yaml.ts:86–93) wraps Zod's
// `.message` with the source path, producing the final shape:
//
//   "Schema validation failed for skills/foo/skill.yaml:
//    process[2].if: invalid if: expression — see docs/skill-grammar-guide.md"
//
// No changes needed to `loader.ts` or `yaml.ts` — pre-research §8.1
// verified the existing formatter threads paths + field positions cleanly.
//
// Perf: each refinement runs lex+parse+ast (no cache hit here — the cache
// in `evaluator/expression/cache.ts` is for `evalCondition` reads). Pre-
// research §8.1 estimated ~30ms for a 100-skill pack with avg 3 `if:`
// clauses each (300 invocations × ~0.1ms grammar). Runs once per process
// start; acceptable.
// ---------------------------------------------------------------------------

const conditionString = z.string().refine(
  (s) => {
    if (s.trim() === '') return true;
    try {
      parseExpression(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'invalid if: expression — see docs/skill-grammar-guide.md' },
);

// ---------------------------------------------------------------------------
// ProcessStep — one step inside a rule's process.
//
// `call` — the primitive function name (regex_match, llm_classify, verdict,
//          recall, store_lesson, etc.).
// `args` — opaque key-value bag; per-primitive Zod refinement lands in the
//          function-library registry (separate from this YAML schema).
// `as`   — variable binding for downstream steps (`as: hit` then `if: hit`).
// `if`   — conditional execution expression (evaluator-interpreted). Wrapped
//          in `conditionString` for load-time grammar validation (H.2).
// `on_empty` — what verdict to emit when the call produces no output.
//
// Note: a second `ProcessStep` schema lives at `src/runtime/types.ts:93–99`
// with a loose `if: z.string().optional()`. The YAML load path goes through
// THIS schema (the load-time validation entry point); de-duplication is a
// separate cleanup task (out of scope for H.2).
// ---------------------------------------------------------------------------

export const ProcessStep = z.object({
  call: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  as: z.string().optional(),
  if: conditionString.optional(),
  on_empty: z.enum(['pass', 'block', 'continue']).optional(),
});
export type ProcessStep = z.infer<typeof ProcessStep>;

// ---------------------------------------------------------------------------
// RuleKindEnum — two anti-drift flavors per design doc §"Anti-drift split".
//
// `track_check`       — deterministic workflow rule (regex, count, sequence).
// `destination_check` — LLM-judged goal-alignment check via model alias.
// Default: track_check (the more common case).
//
// Phase 4 splits the formerly-flat `Rule` schema into a discriminated union on
// `kind` so each flavor carries only the fields it actually uses
// (track_check has `process`, destination_check has `interval` +
// `model_alias` + `prompt_template`). The enum is kept as a public re-export
// for callers that want the union-of-literal-strings as a single type.
// ---------------------------------------------------------------------------

export const RuleKindEnum = z.enum(['track_check', 'destination_check']);
export type RuleKindEnum = z.infer<typeof RuleKindEnum>;

// ---------------------------------------------------------------------------
// TrackCheckRule — deterministic workflow rule.
//
// `kind` keeps its `.default('track_check')` so existing pack YAML that omits
// the field (the Phase 1–3 common case) continues to parse. Combined with the
// `Rule`-level preprocess (below), pack authors can author a rule without any
// `kind:` field at all and still land in this branch.
//
// `process` is required (`min(1)`): a track_check with no steps is a no-op
// that would silently never fire — almost always a YAML mistake.
// ---------------------------------------------------------------------------

export const TrackCheckRule = z.object({
  id: z.string().min(1),
  kind: z.literal('track_check').default('track_check'),
  // T-ASC ASC.5: per-rule AND-preconditions evaluated at the dispatcher
  // boundary AFTER skill.requires and BEFORE walking the process. Each entry
  // is a SkillRequires discriminated-union variant. Empty array trivially
  // holds (back-compat). Per-rule requires support different chain_stage
  // values across rules in the same skill (the skill-level requires is one
  // condition shared across all the skill's rules; per-rule is the natural
  // place for stage-specific gating).
  requires: z.array(SkillRequires).default([]),
  process: z.array(ProcessStep).min(1),
});
export type TrackCheckRule = z.infer<typeof TrackCheckRule>;

// ---------------------------------------------------------------------------
// DestinationCheckRule — LLM-judged goal-alignment check.
//
// `interval`         — required. Periodic firing cadence (per N tool calls).
//                      The scheduler (Task 4.3) reads this and counts events.
// `model_alias`      — defaults to `'reasoning'` (cheapest model-neutral
//                      label for a judgement call; user maps to a concrete
//                      backend in `models.yaml`).
// `prompt_template`  — required string. Pack-authored prompt. Empty string
//                      parses (loosest validation) but the runtime primitive
//                      (Task 4.2) surfaces it on first invoke; we deliberately
//                      let typos through so the failure mode is loud at runtime
//                      rather than silently rejected at load.
//
// Note: no `process` field — destination_check fires through a dedicated
// primitive (`check_destination`), not the generic process evaluator. Adding
// `process` here would be a footgun (pack authors would mix `process` with
// `prompt_template` and expect both to do something).
// ---------------------------------------------------------------------------

export const DestinationCheckRule = z.object({
  id: z.string().min(1),
  kind: z.literal('destination_check'),
  interval: z.object({ every_n_tool_calls: z.number().int().positive() }),
  model_alias: z.string().default('reasoning'),
  prompt_template: z.string(),
});
export type DestinationCheckRule = z.infer<typeof DestinationCheckRule>;

// ---------------------------------------------------------------------------
// Rule — discriminated union on `kind`.
//
// `z.discriminatedUnion` is strict about presence: it requires the discriminant
// field to be a literal string. That collides with the Phase 1–3 convention
// where pack authors author track_check rules without writing `kind:` at all
// (defaulting to track_check). We compensate via a `z.preprocess` shim that
// fills in `kind: 'track_check'` when missing, BEFORE the discriminated union
// runs. The shim is a no-op for any input that already declares `kind`, so
// destination_check rules pass through unchanged.
//
// The preprocess input is `unknown` (not a typed object) because Zod's
// discriminated-union signature accepts `unknown` and any narrower type would
// reject legitimate YAML shapes (e.g. arrays accidentally placed where an
// object should be — we want those to surface as proper Zod errors, not type
// crashes inside the shim).
// ---------------------------------------------------------------------------

export const Rule = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      // Non-object input — pass through so the discriminated union rejects with
      // a sensible "expected object" error instead of throwing in the shim.
      return input;
    }
    const obj = input as Record<string, unknown>;
    if (obj.kind === undefined) {
      return { ...obj, kind: 'track_check' };
    }
    return obj;
  },
  z.discriminatedUnion('kind', [TrackCheckRule, DestinationCheckRule]),
);
export type Rule = z.infer<typeof Rule>;

// ---------------------------------------------------------------------------
// Trigger — which Event kinds fire this skill (AUTO.1).
//
// Authoritative source: `docs/tasks/automation.md` AUTO.1 "Key code shapes"
// section + memory `project_opensquid_modular_function_skill_separation`.
//
// A skill's `triggers:` list declares which `Event` kinds the dispatcher
// should evaluate the skill against. Default (block omitted at the Skill
// level) is `[{kind: 'tool_call'}]` — back-compat with every Phase 1–7 pack
// that pre-dates the wider Event union.
//
// Discriminated union on `kind` matching `EventKind` (one variant per Event
// kind) so the schema can carry kind-specific filter args without leaking
// into the bare event payload. Per-trigger filter args are loose at AUTO.1
// and refined by the downstream trigger sources:
//
//   - `schedule.cron`         — read by SCHED.1 scheduler
//   - `webhook.path`          — read by SCHED.2 webhook intake
//   - `file_changed.paths`    — read by AUTO.5 chokidar watcher
//   - `inbound_channel.channel` — read by AUTO.6 inbound router (abstract
//                                channel name; user maps via channels.yaml)
//
// `tool_call`, `prompt_submit`, `session_end`, `stop` carry no filter args
// at this layer — the host hook delivers the event verbatim and the rule
// process inside the skill does any per-tool / per-prompt filtering via the
// existing `tool_name`, `tool_args`, `match_command` primitives.
//
// Risk callout (per task spec): the loader MUST refuse an empty
// `triggers: []` rather than silently defaulting to "all kinds" or "no
// kinds." Empty means the pack author wrote something they didn't intend;
// the schema rejects with a Zod issue path pointing at the offending field.
// ---------------------------------------------------------------------------

/**
 * Re-export the eight event kinds as the canonical trigger-kind set.
 *
 * Trigger.kind ⊆ EventKind by construction (each `Trigger` variant's
 * discriminator is one of the eight `EventKind` literals). Consumers that
 * need the bare set of trigger kinds (audit logs, doctor output, AUTO.2
 * `rate_limits:` keys) import this rather than re-typing the literals.
 *
 * The `Trigger` schema + `DEFAULT_TRIGGERS` constant itself lives in
 * `runtime/types.ts` (single source of truth alongside `Event`). YAML
 * callers should import them from there directly; skill.ts only references
 * them via the local `import` for the Skill schema's `triggers:` field.
 */
export const TriggerKind = EventKind;
export type TriggerKind = z.infer<typeof TriggerKind>;

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
  // T-ASC ASC.2: AND-semantic preconditions evaluated at the dispatcher
  // boundary BEFORE walking rules. Empty array trivially holds (back-compat
  // with every Phase 1+ pack — defaults applied). Each entry is a
  // discriminated-union variant from `runtime/skill_requires.ts` (kinds:
  // automation_mode_on, active_task_present, chain_stage). A skill that
  // declares `requires:` short-circuits at the dispatcher when any
  // precondition fails — its rules don't evaluate.
  requires: z.array(SkillRequires).default([]),
  unloads_when: z.array(UnloadCondition).default([]),
  // AUTO.1: `triggers:` declares which `Event` kinds fire this skill.
  // - omitted        → default to `[{kind: 'tool_call'}]` via the factory
  //                    above (back-compat with every Phase 1–7 pack).
  // - non-empty list → discriminated union per `EventKind`; the dispatcher
  //                    filters by `event.kind ∈ triggers.map(t => t.kind)`.
  // - empty list     → REJECTED (`.min(1)`). Refusing to load an explicitly
  //                    empty trigger list is the no-silent-fail-open posture
  //                    required by the spec risk callout: the loader never
  //                    silently disables a skill, and never silently enables
  //                    every event kind.
  triggers: z
    .array(Trigger)
    .min(1, 'triggers must not be empty — omit the block to default to tool_call')
    .default(defaultTriggers),
  rules: z.array(Rule).default([]),
  tools: z.array(z.string()).default([]),
  prose: z.string().optional(),
});
export type Skill = z.infer<typeof Skill>;

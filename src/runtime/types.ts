/**
 * Core runtime types for the opensquid substrate.
 *
 * Every type is paired with a Zod schema and a `z.infer` line so that TS and
 * runtime validation never drift apart. Schemas validate untrusted input
 * (event payloads from hosts, pack YAML, RAG payloads); inferred types flow
 * through the rest of the runtime as compile-time guarantees.
 *
 * Type → source-of-truth in `docs/opensquid-real-design.md`:
 *
 *   Event       — §"The architecture in six concepts" (concept 1)
 *                 eight kinds: tool_call | prompt_submit | session_end | stop
 *                 | schedule | webhook | inbound_channel | file_changed
 *                 (AUTO.1 widened the union from 4 → 8 to back the four
 *                 non-tool-call triggers: scheduler ticks, webhook intakes,
 *                 inbound channel messages, and file-change watchers.)
 *   Verdict     — §"Anti-drift split" (rule output)
 *                 level: pass | block | warn | surface
 *   ProcessStep — §"Skill format" (rules are processes, not typed checks)
 *   Rule        — §"The architecture in six concepts" (concept 3)
 *                 kind: track_check (deterministic) | destination_check (LLM-judged)
 *   Skill       — §"Skill format" + §"Skill properties"
 *                 load mode + when_to_load + unloads_when + rules + prose
 *   Pack        — §"Pack format" + §"Manifest fields"
 *                 name / version / scope / goal required; rest defaulted
 *   RuleResult  — TS-only union (never crosses a process boundary, so no schema)
 *
 * Looseness is deliberate at `ProcessStep.args` and `ToolCallEvent.args`:
 * tightening means migrating every primitive. The task spec calls this out
 * (Task 1.1 risk callout). Per-function refinement lands in Task 1.2.
 */

import { z } from 'zod';

import { ChatAgentSchema } from '../packs/schemas/chat_agent.js';
import { DriftResponseConfig } from '../packs/schemas/drift_response.js';
import {
  ActivationScope,
  BaseVersion,
  CompositeInclude,
  DetectedByCheck,
  Foundation,
  PackKind,
  PackUsage,
  SeedLesson,
  VerifyGate,
  Guard,
} from '../packs/schemas/manifest.js';
import { Team } from '../packs/schemas/team.js';
import { ModelsConfig } from '../packs/schemas/models.js';
import { Fsm } from './fsm.js';

// ---------------------------------------------------------------------------
// Verdict — rule output (T-ASC ASC.3 discriminated-union refactor)
//
// Before T-ASC ASC.3 the Verdict was a flat object {level, message, ruleId?}
// for 4 levels. ASC.3 adds a 5th level `directive` whose payload is
// `next_action: NextAction` instead of `message: string`. The schema becomes
// a discriminated union on `level` so the runtime narrows precisely — a
// directive verdict has no `message`, a message-bearing verdict has no
// `next_action`, and TypeScript enforces the right access at compile time.
// `MessageVerdict` is the narrowed alias drift-path consumers (drift_response,
// escalate, auto_correct) take; `DirectiveVerdict` is the alias the
// dispatcher's directive-aggregation path consumes.
// ---------------------------------------------------------------------------

export const VerdictLevel = z.enum(['pass', 'block', 'warn', 'surface', 'directive']);
export type VerdictLevel = z.infer<typeof VerdictLevel>;

/**
 * NextAction — payload of a `level: 'directive'` verdict. Names the next
 * skill OR tool the agent should run (skill XOR tool, never both); `args`
 * threads the call through; `rationale` is the mandatory plain-English
 * explanation that lands in the agent's pre-prompt context.
 *
 * Per T-ASC L7 + project_opensquid_no_agent_loop: opensquid emits the
 * directive, the agent dispatches. The skill name here is informational —
 * opensquid does NOT invoke it.
 */
/**
 * DPC.1 (2026-05-30) — extended to 3-way XOR (skill / tool / profession).
 * The `profession` field points at an opensquid built-in profession pack
 * (e.g. `task-spec-author`, `scope-architect`) under `packs/builtin/<name>/`
 * or at a user-scope profession pack under `~/.opensquid/packs/<name>/`.
 * Chain-handoff directives (T-ASC ASC.5) use `profession:` to route the
 * agent to spawn_subagent with the named pack's team-role manifest. The
 * agent loads the pack, applies the role's `instructions` + pinned skills,
 * runs the subagent — opensquid stays passive per
 * [[project_opensquid_no_agent_loop]].
 */
export const NextAction = z
  .object({
    skill: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    profession: z.string().min(1).optional(),
    args: z.record(z.unknown()).optional(),
    rationale: z.string().min(1),
  })
  .strict()
  .refine(
    (na) => {
      const set = [na.skill, na.tool, na.profession].filter((v) => v !== undefined).length;
      return set === 1;
    },
    {
      message:
        'next_action.skill XOR next_action.tool XOR next_action.profession — exactly one must be set',
      path: ['skill'],
    },
  );
export type NextAction = z.infer<typeof NextAction>;

export const Verdict = z.discriminatedUnion('level', [
  z.object({
    level: z.literal('pass'),
    message: z.string(),
    ruleId: z.string().optional(),
  }),
  z.object({
    level: z.literal('block'),
    message: z.string(),
    ruleId: z.string().optional(),
  }),
  z.object({
    level: z.literal('warn'),
    message: z.string(),
    ruleId: z.string().optional(),
  }),
  z.object({
    level: z.literal('surface'),
    message: z.string(),
    ruleId: z.string().optional(),
  }),
  z.object({
    level: z.literal('directive'),
    next_action: NextAction,
    ruleId: z.string().optional(),
  }),
]);
export type Verdict = z.infer<typeof Verdict>;

/** Verdicts that carry a human-readable message (every level except directive). */
export type MessageVerdict = Extract<Verdict, { message: string }>;

/** Directive-level verdict (level: 'directive', carries next_action). */
export type DirectiveVerdict = Extract<Verdict, { level: 'directive' }>;

/**
 * A directive emitted by a rule and aggregated by the dispatcher. Peer to
 * the inject_context aggregation: directives accumulate in
 * `DispatchResult.directives` across the walk and the UserPromptSubmit hook
 * bin serializes them into the envelope's additionalContext.
 */
export interface Directive {
  next_action: NextAction;
  ruleId?: string;
}

// ---------------------------------------------------------------------------
// Event + EventKind + Trigger — split into `./event.ts` per AUTO.1 file-size
// constraint (types.ts must stay under 400 LOC). The barrel re-export below
// preserves every existing `import { Event } from './types.js'` callsite so
// the split is internal layout, not a public-API change.
//
// Naming note: spec says "split into `types/event.ts`" but we use
// `./event.ts` (sibling, not subdir) to avoid the NodeNext name collision
// between sibling file `types.ts` and sibling directory `types/`. Same
// outcome, simpler resolver.
// ---------------------------------------------------------------------------

export {
  DEFAULT_TRIGGERS,
  Event,
  EventKind,
  FileChangedEvent,
  InboundChannelEvent,
  PromptSubmitEvent,
  ScheduleEvent,
  SessionEndEvent,
  SessionStartEvent,
  StopEvent,
  ToolCallEvent,
  Trigger,
  WebhookEvent,
  defaultTriggers,
} from './event.js';

// Internal re-import: the Skill schema below references `Trigger` +
// `defaultTriggers`. We import them locally rather than relying on the
// re-export above (NodeNext doesn't let a file consume its own re-exports
// without a separate import statement).
import { Trigger, defaultTriggers } from './event.js';
// T-ASC ASC.2: the Skill schema's new `requires:` field references
// `SkillRequires` from the precondition evaluator module.
import { SkillRequires } from './skill_requires.js';

// Re-export so external callers can `import { SkillRequires } from
// '../runtime/types.js'` (conventional barrel) — mirrors how Trigger
// is exported via the './event.js' re-export above.
export { SkillRequires } from './skill_requires.js';
export type { RequiresCache } from './skill_requires.js';

// ---------------------------------------------------------------------------
// Rule + ProcessStep — rules are processes (sequences of primitive calls)
//
// `args` and `if` stay loose at this layer; per-function Zod refinement is
// planned for Task 1.2 (function-library registry). `on_empty` is the
// early-exit verdict when a `call` produces no meaningful output.
// ---------------------------------------------------------------------------

export const ProcessStep = z.object({
  call: z.string(),
  args: z.record(z.unknown()).optional(),
  as: z.string().optional(),
  if: z.string().optional(),
  on_empty: z.enum(['pass', 'block', 'continue']).optional(),
  // on_error: how the evaluator treats a failing primitive. Absent / 'abort'
  // (default) → return kind:'error' (historical hard-abort). 'continue' → bind
  // the error message to `as` (if set) and proceed, letting the rule observe
  // the failure (e.g. an audit subagent that could not spawn) and branch on it.
  on_error: z.enum(['abort', 'continue']).optional(),
});
export type ProcessStep = z.infer<typeof ProcessStep>;

export const RuleKind = z.enum(['track_check', 'destination_check']);
export type RuleKind = z.infer<typeof RuleKind>;

// ---------------------------------------------------------------------------
// Rule — runtime view of a pack rule.
//
// Phase 4 splits this into a discriminated union to match the YAML schema in
// `src/packs/schemas/skill.ts`. Track-check rules carry `process` (a sequence
// of primitive calls walked by `evaluateProcess`). Destination-check rules
// carry `interval` + `model_alias` + `prompt_template` — they fire through the
// dedicated `check_destination` primitive (Task 4.2) on the scheduler tick
// (Task 4.3), not through the process evaluator.
//
// Why duplicate the YAML schema here: the YAML schema validates pack files
// on disk; the runtime schema is the cross-process contract (env-var test
// seam, MCP tool args, future RAG-side state writes). Both must stay aligned;
// drift between them is caught by the schema cross-test plus the
// `validatePackFunctions` walker which type-checks against this `Rule`.
// ---------------------------------------------------------------------------

export const TrackCheckRule = z.object({
  id: z.string(),
  kind: z.literal('track_check').default('track_check'),
  // T-ASC ASC.5: per-rule AND-preconditions; same shape as Skill.requires.
  requires: z.array(SkillRequires).default([]),
  process: z.array(ProcessStep),
});
export type TrackCheckRule = z.infer<typeof TrackCheckRule>;

export const DestinationCheckRule = z.object({
  id: z.string(),
  kind: z.literal('destination_check'),
  interval: z.object({ every_n_tool_calls: z.number().int().positive() }),
  model_alias: z.string().default('reasoning'),
  prompt_template: z.string(),
});
export type DestinationCheckRule = z.infer<typeof DestinationCheckRule>;

// `kind` defaults to `'track_check'` when missing (Phase 1–3 ergonomic) via
// the same preprocess shim used in the YAML schema. Keeps the env-var test
// seam (which feeds pre-parsed pack JSON) working without explicit `kind`.
export const Rule = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
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
// Skill — unit of work-discipline that loads + unloads on declared conditions
//
// `when_to_load` and `unloads_when` stay `unknown[]` here; the matcher schema
// is refined in Task 3.1 / 3.2 when load-condition primitives land.
// ---------------------------------------------------------------------------

export const LoadMode = z.enum(['preload', 'lazy']);
export type LoadMode = z.infer<typeof LoadMode>;

export const Skill = z.object({
  name: z.string(),
  load: LoadMode.default('lazy'),
  when_to_load: z.array(z.unknown()).default([]),
  // T-ASC ASC.2: AND-semantic preconditions evaluated at the dispatcher
  // boundary BEFORE walking rules. Same shape as the YAML-side `requires:`
  // block (discriminated-union via `SkillRequires`). Empty array trivially
  // holds — back-compat with every Phase 1+ pack. Each entry is a
  // discriminated-union variant (kinds: automation_mode_on,
  // active_task_present, chain_stage); see `skill_requires.ts` for the
  // evaluator + RequiresCache.
  requires: z.array(SkillRequires).default([]),
  unloads_when: z.array(z.unknown()).default([]),
  // AUTO.1: same shape as the YAML-side `triggers:` block. The runtime view
  // is the post-load contract; refusing empty arrays here keeps the
  // env-var test seam (which feeds pre-parsed pack JSON) from sneaking an
  // empty list past the YAML loader.
  triggers: z.array(Trigger).min(1).default(defaultTriggers),
  rules: z.array(Rule).default([]),
  prose: z.string().optional(),
});
export type Skill = z.infer<typeof Skill>;

// ---------------------------------------------------------------------------
// Pack — manifest + skills (memory lives outside packs)
//
// `evolves: true` default — wedge gate may mutate skills unless the pack
// author opts out. Required-vs-defaulted matches §"Manifest fields" exactly.
// ---------------------------------------------------------------------------

export const Scope = z.enum(['universal', 'domain', 'specialty', 'workflow', 'project']);
export type Scope = z.infer<typeof Scope>;

// `chatAgent` is the WAB.6 chat-agent binding side-file (`chat_agent.yaml`),
// folded into the runtime Pack only when the pack ships one. Absent =
// `undefined` (not an empty object) so consumers can distinguish "pack
// shipped no chat-agent binding" from "shipped one with defaults" — the
// runtime's `buildChatToolDispatcher` reads `undefined` as "fall back to
// built-in defaults" without ever surfacing a phantom file.
//
// The side-file is intentionally additive: every existing pack stays valid
// without authoring a `chat_agent.yaml`. Only consumers that opt into the
// warm-agent chat bridge (WAB.6+) read the field.
//
// `models` is the optional `models.yaml` side-file folded into the Pack —
// pack-declared model aliases (`fast_classifier`, `reasoning`, etc.). The
// runtime's model-config resolver (PR-followup) reads this AFTER env vars
// and user-level `~/.opensquid/models.yaml` overrides, so a pack-shipped
// alias acts as the "out-of-the-box default" that the user can override.
// Absent = `undefined`; downstream resolvers treat that as "no pack
// contributions" and only consult env + user-yaml. See `models/load_config.ts`.
//
// `driftResponse` is the optional `drift_response.yaml` side-file. When
// present, the hook dispatcher (`runtime/hooks/dispatch.ts`) resolves each
// rule's policy via `driftResponse.per_rule[rule.id] ?? driftResponse.default`
// instead of the historical hard-coded `block_tool` default. Absent =
// `undefined`; the dispatcher falls back to `block_tool` as the Phase 1
// conservative default so existing packs that don't ship the file behave
// identically to pre-PR-followup. See `runtime/hooks/dispatch.ts` for the
// resolve-precedence chain.
export const Pack = z.object({
  name: z.string(),
  version: z.string(),
  scope: Scope,
  goal: z.string(),
  description: z.string().default(''),
  requires: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  extends: z.string().optional(),
  evolves: z.boolean().default(true),
  skills: z.array(Skill).default([]),
  chatAgent: ChatAgentSchema.optional(),
  models: ModelsConfig.optional(),
  driftResponse: DriftResponseConfig.optional(),
  // IDF.1 (2026-05-30) — v0.6 pack content-richness restored. camelCase
  // runtime mapping for the snake_case manifest fields (foundation /
  // activation_scope / detected_by). See schemas/manifest.ts for the
  // YAML-side shapes. ALL optional on the runtime Pack type so test
  // fixtures + non-loadPack callers can construct Pack literals without
  // these fields (back-compat). The YAML loader (loader.ts) supplies the
  // defaults explicitly. Downstream consumers (IDF.4 dispatcher) read
  // `pack.activationScope ?? 'project'` defensively.
  foundation: Foundation.optional(),
  activationScope: ActivationScope.optional(),
  detectedBy: z.array(DetectedByCheck).optional(),
  // MM.1 (2026-05-30) — multi-mode pack addressing. All three optional on
  // the runtime Pack type so test fixtures + non-loadPack callers can
  // construct Pack literals without these fields (back-compat). The YAML
  // loader (loader.ts) supplies the defaults explicitly. Downstream
  // consumers read defensively via ?? coalesce ('focused' / 'active' / []).
  kind: PackKind.optional(),
  usage: PackUsage.optional(),
  includes: z.array(CompositeInclude).optional(),
  // MM.2 (2026-05-30) — loaded team.yaml. The loader (loader.ts) reads +
  // parses team.yaml when usage is 'profession' | 'both'; absent for
  // 'active' packs. Optional on the runtime type so test fixtures can
  // construct Pack literals without it. Consumed by the dispatcher's
  // profession-directive validator (profession_resolver.ts).
  team: Team.optional(),
  // LP.1 (2026-05-30) — living-pack fields. baseVersion is the immutable
  // vanilla baseline; personalRevisionId is the monotonic count of
  // promoted lessons; lastMergedVanilla is the most recent vanilla
  // version successfully 3-way-merged (LP.2 will populate). All three
  // OPTIONAL: built-in packs (bundled in npm) have no personal_revision
  // dir; only installed packs at ~/.opensquid/packs/ carry them.
  baseVersion: BaseVersion.optional(),
  personalRevisionId: z.number().int().nonnegative().optional(),
  lastMergedVanilla: BaseVersion.nullable().optional(),
  // DOG.5 (2026-05-30) — convenience view of the LP.1 version.json shape as
  // `<base>.<rev>` triple. Present iff the loader read a non-null
  // PersonalRevision from `<user-home>/.opensquid/packs/<pack-id>/
  // personal_revision/version.json`. Absent for built-in packs that ship
  // in the npm tree without per-user installation. Equivalent to
  // `pack.baseVersion === version.base && pack.personalRevisionId ===
  // version.revision` but pre-formatted as a single object for log /
  // diagnostic surfaces.
  livingVersion: z
    .object({ base: z.string(), revision: z.number().int().nonnegative() })
    .optional(),
  // DOG.3 (2026-05-30) — schema-sugar manifest blocks hoisted onto Pack so
  // downstream consumers (ingest pipeline, audit-trail surface, fixture
  // sync) can read without re-parsing the manifest YAML. Optional on the
  // runtime Pack type so test fixtures + non-loadPack callers can
  // construct Pack literals without these fields (back-compat); the YAML
  // loader (loader.ts) supplies the defaults explicitly.
  seedLessons: z.array(SeedLesson).optional(),
  verifyGates: z.array(VerifyGate).optional(),
  guards: z.array(Guard).optional(),
  /** Pack-declared lifecycle FSM (slice A2; from `fsm.yaml`). Validated total. */
  fsm: Fsm.optional(),
});
export type Pack = z.infer<typeof Pack>;

// ---------------------------------------------------------------------------
// RuleResult — in-process evaluation outcome (TS-only, no schema)
//
// A rule evaluates to one of four states. `error` carries the failing step
// index so the runtime can surface which `call` blew up. `inject_context`
// (G.4) is the non-verdict, non-error terminal state used by the
// `recall_pre_inject` primitive: it carries a formatted string the hook
// layer prepends to the host's context (for `UserPromptSubmit`, Claude
// Code's `hookSpecificOutput.additionalContext` JSON envelope). Other
// terminal RuleResult variants are PER-RULE; `inject_context` is aggregated
// at dispatch level into `DispatchResult.contextInjections: string[]` so
// multiple skills can stack their injections in one prompt.
// ---------------------------------------------------------------------------

/**
 * T-ASC ASC.3: RuleResult gains a `directive` variant that the dispatcher
 * aggregates separately from the `verdict` variant (which carries a
 * MessageVerdict only — directives don't flow through drift_response).
 * The evaluator forks at the verdict-primitive special-case: a value with
 * `level === 'directive'` becomes `{kind: 'directive'}`, every other level
 * becomes `{kind: 'verdict'}`.
 */
export type RuleResult =
  | { kind: 'verdict'; verdict: MessageVerdict }
  | { kind: 'directive'; directive: Directive }
  | { kind: 'no_verdict' }
  | { kind: 'error'; error: string; step: number }
  | { kind: 'inject_context'; content: string };

// ---------------------------------------------------------------------------
// DriftPolicy + RuntimeAction — what the runtime does once a rule fires.
//
// TS-only union (no Zod). These descriptors never cross a serialization
// boundary: a rule produces a `Verdict`, the dispatcher (`drift_response.ts`)
// maps `(Verdict, DriftPolicy) → RuntimeAction`, and the hook layer (Task 1.7)
// turns the action into a process exit-code / channel notification / state
// write. Adding/removing variants is a runtime concern, not a YAML one.
//
// All 6 policies per design doc §"Drift response policies":
//   block_tool          — refuse the pending tool call with a message
//   warn                — let the tool through but surface a message
//   full_stop_and_redo  — halt the entire task, restart from entry skill
//   notify_and_pause    — pause + multicast the verdict to channels
//   auto_correct        — invoke a pack-declared corrective skill, then
//                         re-evaluate the offending rule (AUTO.4)
//   escalate            — bump severity to 'critical' and reroute the
//                         verdict via NotificationRouter (AUTO.4)
//
// The dispatcher in `drift_response.ts` produces an action *descriptor* for
// each policy. `auto_correct` and `escalate` are dispatched as descriptors
// (`{kind: 'auto_correct', ...}` / `{kind: 'escalate', ...}`) that the
// upper-layer runtime (auto_correct.ts / escalate.ts) interprets — they
// require I/O (evaluator invocation, NotificationRouter multicast,
// RateLimiter check) so they cannot be pure handler functions like the
// other four. The hook layer (Task 1.7) wires the side-effect path.
//
// The dispatcher fail-safe (in drift_response.ts) catches unknown policy
// strings and degrades to `notify_pause` with severity 'critical' rather
// than silently fail-opening (constraint C10).
//
// `RuntimeAction.kind: 'halt'` carries an optional `entrySkill` so the
// `full_stop_and_redo` policy can declare a restart entry; the field stays
// optional because the hook layer can substitute the pack's default entry
// skill when the verdict doesn't pin one.
// ---------------------------------------------------------------------------

export type DriftPolicy =
  | 'block_tool'
  | 'warn'
  | 'full_stop_and_redo'
  | 'notify_and_pause'
  | 'auto_correct'
  | 'escalate';

export type RuntimeAction =
  | { kind: 'block_tool'; message: string }
  | { kind: 'warn'; message: string }
  | { kind: 'halt'; reason: string; entrySkill?: string }
  | { kind: 'notify_pause'; reason: string; severity: 'critical' | 'error' | 'warning' }
  | { kind: 'auto_correct'; correctiveSkill: string; verdict: Verdict }
  | { kind: 'escalate'; reroutedSeverity: 'critical'; verdict: Verdict };

// ---------------------------------------------------------------------------
// PauseState — persisted session-level halt marker (Task 1.18)
//
// Written atomically to `sessionStateFile(sessionId, 'pause')` by
// `notifyAndPause` whenever the runtime must halt the session for user
// intervention. Hooks (Task 1.7+) read this file on every event so that a
// paused session short-circuits before any rule evaluation runs.
//
// TS-only — the file content is opensquid-owned, never authored by users
// or pack YAML, so no Zod schema is needed at the read boundary. The
// `triggeredAt` field is an ISO-8601 string (set by `notifyAndPause`).
// `ruleId` / `packId` are optional context for the eventual unpause UX.
// ---------------------------------------------------------------------------

export interface PauseState {
  reason: string;
  triggeredAt: string;
  ruleId?: string;
  packId?: string;
}

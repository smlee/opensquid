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
 *                 four kinds: tool_call | prompt_submit | session_end | stop
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

// ---------------------------------------------------------------------------
// Verdict — rule output
// ---------------------------------------------------------------------------

export const VerdictLevel = z.enum(['pass', 'block', 'warn', 'surface']);
export type VerdictLevel = z.infer<typeof VerdictLevel>;

export const Verdict = z.object({
  level: VerdictLevel,
  message: z.string(),
  ruleId: z.string().optional(),
});
export type Verdict = z.infer<typeof Verdict>;

// ---------------------------------------------------------------------------
// Event — discriminated union on `kind`
//
// Use `z.discriminatedUnion` (not `z.union`) so TS narrows on `event.kind`
// inside a `switch` and ZodError points at the right variant on rejection.
// ---------------------------------------------------------------------------

export const ToolCallEvent = z.object({
  kind: z.literal('tool_call'),
  tool: z.string(),
  args: z.record(z.unknown()),
  cwd: z.string().optional(),
});
export type ToolCallEvent = z.infer<typeof ToolCallEvent>;

export const PromptSubmitEvent = z.object({
  kind: z.literal('prompt_submit'),
  prompt: z.string(),
});
export type PromptSubmitEvent = z.infer<typeof PromptSubmitEvent>;

export const SessionEndEvent = z.object({
  kind: z.literal('session_end'),
  sessionId: z.string(),
});
export type SessionEndEvent = z.infer<typeof SessionEndEvent>;

export const StopEvent = z.object({
  kind: z.literal('stop'),
  assistantText: z.string(),
});
export type StopEvent = z.infer<typeof StopEvent>;

export const Event = z.discriminatedUnion('kind', [
  ToolCallEvent,
  PromptSubmitEvent,
  SessionEndEvent,
  StopEvent,
]);
export type Event = z.infer<typeof Event>;

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
});
export type ProcessStep = z.infer<typeof ProcessStep>;

export const RuleKind = z.enum(['track_check', 'destination_check']);
export type RuleKind = z.infer<typeof RuleKind>;

export const Rule = z.object({
  id: z.string(),
  kind: RuleKind.default('track_check'),
  process: z.array(ProcessStep),
});
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
  unloads_when: z.array(z.unknown()).default([]),
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
});
export type Pack = z.infer<typeof Pack>;

// ---------------------------------------------------------------------------
// RuleResult — in-process evaluation outcome (TS-only, no schema)
//
// A rule evaluates to one of three states. `error` carries the failing step
// index so the runtime can surface which `call` blew up.
// ---------------------------------------------------------------------------

export type RuleResult =
  | { kind: 'verdict'; verdict: Verdict }
  | { kind: 'no_verdict' }
  | { kind: 'error'; error: string; step: number };

// ---------------------------------------------------------------------------
// DriftPolicy + RuntimeAction — what the runtime does once a rule fires.
//
// TS-only union (no Zod). These descriptors never cross a serialization
// boundary: a rule produces a `Verdict`, the dispatcher (`drift_response.ts`)
// maps `(Verdict, DriftPolicy) → RuntimeAction`, and the hook layer (Task 1.7)
// turns the action into a process exit-code / channel notification / state
// write. Adding/removing variants is a runtime concern, not a YAML one.
//
// Phase 1 ships 4 of 6 policies per design doc §"Drift response policies":
//   block_tool          — refuse the pending tool call with a message
//   warn                — let the tool through but surface a message
//   full_stop_and_redo  — halt the entire task, restart from entry skill
//   notify_and_pause    — pause + multicast the verdict to channels
//
// `auto_correct` and `escalate` are intentionally deferred — they require
// the auto-correction skill loop + escalation routing primitives that land
// in later phases. The dispatcher fail-safe (in drift_response.ts) catches
// unknown policy strings and degrades to `notify_pause` with severity
// 'critical' rather than silently fail-opening (constraint C10).
//
// `RuntimeAction.kind: 'halt'` carries an optional `entrySkill` so the
// `full_stop_and_redo` policy can declare a restart entry; the field stays
// optional because the hook layer can substitute the pack's default entry
// skill when the verdict doesn't pin one.
// ---------------------------------------------------------------------------

export type DriftPolicy = 'block_tool' | 'warn' | 'full_stop_and_redo' | 'notify_and_pause';

export type RuntimeAction =
  | { kind: 'block_tool'; message: string }
  | { kind: 'warn'; message: string }
  | { kind: 'halt'; reason: string; entrySkill?: string }
  | { kind: 'notify_pause'; reason: string; severity: 'critical' | 'error' | 'warning' };

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

/**
 * pack-format-v2 — the FSM-primary pack schema (T-fsm-actor-runtime PFV2.1).
 *
 * A pack IS its execution FSM: a map of named states, each a discriminated
 * union over the 5 StateKinds with per-state bindings (executor/skills/guards).
 * `compile_v2.ts` lowers a PackV2 to the reused `runtime/fsm.ts` engine machine
 * + a per-state metadata table the loop driver (LOOP.1) consumes. The loader
 * (PFV2.2) reads `pack.yaml` into a PackV2.
 *
 * Spec: loop/docs/tasks/T-fsm-actor-runtime.md §PFV2.1.
 * Design: loop/docs/opensquid-fsm-architecture.html §7 (packs-are-flowcharts),
 * §3 (the 5 state kinds). The `messages` map is the self-continue store
 * (failure_type → prepared corrective instruction).
 */
import { z } from 'zod';

import { Transition } from '../../runtime/fsm.js';
import { ProcessStep } from '../../runtime/types.js';

export const StateKind = z.enum(['executor', 'gate', 'decision', 'sub_flow', 'terminal']);
export type StateKind = z.infer<typeof StateKind>;

// STRUCTURE vs BEHAVIOR (T1): the transition TARGET is no longer embedded in the state. Each state
// declares the NAMED event it EMITS (the behavior); `fsm.transitions` (a `{from,on,to}[]` list, the
// reused `fsm.ts` shape) routes that event to its target (the structure). One event-driven engine
// serves both execution (the driver emits) and conformance (the hook observes) — see compile_v2.ts.

/** Does the unit of work — spawns `executor(S)` with `skills(S)` + the directive,
 *  emits `emits` only when `completion` (a guard ref) holds (the liveness contract). */
// All state schemas are `.strict()` (matching the reused engine `fsm.ts`): a misplaced cross-kind
// field (e.g. a `guard` on a `kind: executor`) fails LOUD at parse instead of being silently dropped.
const ExecutorState = z
  .object({
    kind: z.literal('executor'),
    executor: z.string().min(1).optional(), // executor-ref; via the agent registry; omit → inherit host default
    skills: z.array(z.string()).default([]),
    directive: z.string().min(1),
    completion: z.string().min(1), // guard ref → gates the emit
    emits: z.string().min(1), // the NAMED completion event (routed by fsm.transitions) — was `next`
  })
  .strict();

/** Pure guard evaluation; pass → emit `on_pass_emits`, fail → an action (block/halt) carrying a failure-type key.
 *  `trigger` (optional) names the OBSERVED events that evaluate this gate (the conformance case); absent =
 *  driver-evaluated (the execution case). */
const GateState = z
  .object({
    kind: z.literal('gate'),
    guard: z.string().min(1),
    trigger: z.array(z.string().min(1)).min(1).optional(), // observed event names this gate reacts to
    on_pass_emits: z.string().min(1), // NAMED pass event (routed by fsm.transitions) — was on_pass.to
    on_fail: z.object({ action: z.enum(['block', 'halt']), message: z.string().min(1) }).strict(),
  })
  .strict();

const DecisionBranch = z.union([
  z.object({ guard: z.string().min(1), emits: z.string().min(1) }).strict(),
  z.object({ else: z.literal(true), emits: z.string().min(1) }).strict(),
]);

/** Branch on a condition; first-match by declared order emits that branch's event. Totality enforced below. */
const DecisionState = z
  .object({
    kind: z.literal('decision'),
    branches: z.array(DecisionBranch).min(1),
  })
  .strict();

/** A compound state: an isolated nested FSM (hierarchical path on resume); emits on its terminal. */
const SubFlowState = z
  .object({
    kind: z.literal('sub_flow'),
    flow: z.string().min(1), // ref to the nested FSM
    emits: z.string().min(1), // emitted on the nested terminal (routed by fsm.transitions) — was on_complete.to
  })
  .strict();

/** Terminal: ends the flow. */
const TerminalState = z
  .object({
    kind: z.literal('terminal'),
    outcome: z.enum(['shipped', 'wedge']),
  })
  .strict();

export const StateV2 = z
  .discriminatedUnion('kind', [
    ExecutorState,
    GateState,
    DecisionState,
    SubFlowState,
    TerminalState,
  ])
  // Decision TOTALITY: a decision must end with exactly one `else` branch, so no input can no-match
  // at runtime (the architecture's totality principle — no silent stall).
  .refine(
    (s) => {
      if (s.kind !== 'decision') return true;
      const elses = s.branches.filter((b): b is { else: true; emits: string } => 'else' in b);
      const last = s.branches[s.branches.length - 1];
      return elses.length === 1 && last !== undefined && 'else' in last;
    },
    { message: 'a decision must end with exactly one `else` branch (totality)' },
  );
export type StateV2 = z.infer<typeof StateV2>;
export type DecisionBranch = z.infer<typeof DecisionBranch>;

export const PackScope = z.enum(['universal', 'domain', 'specialty', 'workflow', 'project']);
export type PackScope = z.infer<typeof PackScope>;

// CONFORMANCE vocabulary (M.1): a conformance pack is an always-active set of `gates`, NOT a behavior FSM.
// The union has EXACTLY the two V1 rule kinds (`runtime/types.ts:225` `RuleKind = ['track_check','destination_check']`),
// each RE-HOMING its V1 rule shape so the migration keeps its EXISTING evaluator (M.1 adds NO evaluation logic):
//   track_check       → walked by `evaluateProcess` (`runtime/evaluator.ts:153`)
//   destination_check → fired by `destination_scheduler.ts` + the `check_destination` primitive
// `process` is a FIELD on a track_check (its `ProcessStep[]`, reused VERBATIM from `runtime/types.ts`) — NOT a third kind.
const ConformanceFail = z
  .object({ action: z.enum(['warn', 'block', 'halt']), message: z.string().min(1) })
  .strict();

const TrackCheckGate = z
  .object({
    kind: z.literal('track_check'),
    trigger: z.array(z.string().min(1)).min(1), // the OBSERVED event(s) that evaluate this gate
    process: z.array(ProcessStep).min(1), // runs via evaluateProcess — the V1 ProcessStep shape, UNCHANGED
    on_fail: ConformanceFail.optional(),
  })
  .strict();

const DestinationCheckGate = z
  .object({
    kind: z.literal('destination_check'),
    prompt_template: z.string().min(1), // runs via the scheduler + check_destination — UNCHANGED
    every_n_tool_calls: z.number().int().positive(),
    model_alias: z.string().min(1).optional(),
    on_fail: ConformanceFail.optional(),
  })
  .strict();

export const ConformanceGate = z.discriminatedUnion('kind', [TrackCheckGate, DestinationCheckGate]);
export type ConformanceGate = z.infer<typeof ConformanceGate>;

/** HAR.1: the named pack-`fsm` wire shape — reused for the `flows` registry of isolated nested machines. */
export const FsmV2 = z.object({
  initial: z.string().min(1),
  states: z.record(z.string(), StateV2),
  transitions: z.array(Transition).default([]), // EXPLICIT named-event edges — the fsm.yaml shape
});
export type FsmV2 = z.infer<typeof FsmV2>;

export const PackV2 = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    scope: PackScope,
    detected_by: z.array(z.unknown()).default([]),
    // ← NOW OPTIONAL: a behavior pack has `fsm`; a conformance/foundation pack does not (M.1).
    fsm: FsmV2.optional(),
    // HAR.1: a FLAT registry of named ISOLATED nested machines; a `sub_flow.flow` is a key into this.
    flows: z.record(z.string(), FsmV2).optional(),
    gates: z.array(ConformanceGate).optional(), // ← conformance form: always-active gates, fsm-less
    guards: z.record(z.string(), z.unknown()).default({}), // guard defs — compiled by the guard subsystem (GUARD.1/EXE.1)
    messages: z.record(z.string(), z.string()).default({}), // self-continue store: failure_type → instruction
    foundation: z.unknown().optional(), // pure expertise (manifest/lessons) — neither fsm nor gates
  })
  .strict()
  // 3-form totality: a pack is a behavior FSM XOR a conformance gate-set XOR foundation-only — never two
  // behaviors. The refine rejects an fsm+gates pack LOUD (the architecture's no-implicit-state principle).
  .refine((p) => !(p.fsm !== undefined && p.gates !== undefined), {
    message: 'a pack has `fsm` (behavior) OR `gates` (conformance), not both',
  });
export type PackV2 = z.infer<typeof PackV2>;

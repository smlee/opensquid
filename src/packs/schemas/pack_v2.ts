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

export const StateKind = z.enum(['executor', 'gate', 'decision', 'sub_flow', 'terminal']);
export type StateKind = z.infer<typeof StateKind>;

/** Does the unit of work — spawns `executor(S)` with `skills(S)` + the directive,
 *  transitions out only when `completion` (a guard ref) holds (the liveness contract). */
// All state schemas are `.strict()` (matching the reused engine `fsm.ts`): a misplaced cross-kind
// field (e.g. a `guard` on a `kind: executor`) fails LOUD at parse instead of being silently dropped.
const ExecutorState = z
  .object({
    kind: z.literal('executor'),
    executor: z.string().min(1).optional(), // executor-ref; via the agent registry; omit → inherit host default
    skills: z.array(z.string()).default([]),
    directive: z.string().min(1),
    completion: z.string().min(1), // guard ref → fires the transition
    next: z.string().min(1), // target on completion
  })
  .strict();

/** Pure guard evaluation; pass → advance, fail → an action (block/halt) carrying a failure-type key. */
const GateState = z
  .object({
    kind: z.literal('gate'),
    guard: z.string().min(1),
    on_pass: z.object({ to: z.string().min(1) }).strict(),
    on_fail: z.object({ action: z.enum(['block', 'halt']), message: z.string().min(1) }).strict(),
  })
  .strict();

const DecisionBranch = z.union([
  z.object({ guard: z.string().min(1), to: z.string().min(1) }).strict(),
  z.object({ else: z.literal(true), to: z.string().min(1) }).strict(),
]);

/** Branch on a condition; first-match by declared order. Totality is enforced on StateV2 below. */
const DecisionState = z
  .object({
    kind: z.literal('decision'),
    branches: z.array(DecisionBranch).min(1),
  })
  .strict();

/** A compound state: an isolated nested FSM (hierarchical path on resume). */
const SubFlowState = z
  .object({
    kind: z.literal('sub_flow'),
    flow: z.string().min(1), // ref to the nested FSM
    on_complete: z.object({ to: z.string().min(1) }).strict(),
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
      const elses = s.branches.filter((b): b is { else: true; to: string } => 'else' in b);
      const last = s.branches[s.branches.length - 1];
      return elses.length === 1 && last !== undefined && 'else' in last;
    },
    { message: 'a decision must end with exactly one `else` branch (totality)' },
  );
export type StateV2 = z.infer<typeof StateV2>;
export type DecisionBranch = z.infer<typeof DecisionBranch>;

export const PackScope = z.enum(['universal', 'domain', 'specialty', 'workflow', 'project']);
export type PackScope = z.infer<typeof PackScope>;

export const PackV2 = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  scope: PackScope,
  detected_by: z.array(z.unknown()).default([]),
  fsm: z.object({
    initial: z.string().min(1),
    states: z.record(z.string(), StateV2),
  }),
  guards: z.record(z.string(), z.unknown()).default({}), // guard defs — compiled by the guard subsystem (GUARD.1/EXE.1)
  messages: z.record(z.string(), z.string()).default({}), // self-continue store: failure_type → instruction
});
export type PackV2 = z.infer<typeof PackV2>;

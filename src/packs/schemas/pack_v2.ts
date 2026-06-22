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
    on_fail: z
      .object({ action: z.enum(['warn', 'block', 'halt']), message: z.string().min(1) })
      .strict(), // 4-action model (kernel.ts:17): warn = proceed+nudge (advance+notice); block/halt = stop
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

// CONFORMANCE-RECONCILE: the fsm-less `gates` form is GONE. Gates belong IN the execution FSM as
// `GateState` nodes (a gate on a transition — the `trigger`=conformance / no-trigger=execution contract
// above); a separate always-active gate-LIST is the v1 rule-list model the flowchart design replaces.

/** HAR.1: the named pack-`fsm` wire shape — reused for the `flows` registry of isolated nested machines. */
export const FsmV2 = z.object({
  initial: z.string().min(1),
  states: z.record(z.string(), StateV2),
  transitions: z.array(Transition).default([]), // EXPLICIT named-event edges — the fsm.yaml shape
});
export type FsmV2 = z.infer<typeof FsmV2>;

// ORCH.1 — the `serves` contract: the FROZEN facet vocabulary a pack declares + the classifier emits, so the
// hard-coded prompt router can match a task to a pack (loop/docs/opensquid-serves-contract.pdf). Two CLOSED
// dictionaries (`intent`, `domain`) — extended only by deliberate edit, NEVER by the model — so a domain word
// can't drift ("webdev" vs "coding"); `stakes` + free qualifiers raise specificity only.
export const MacroIntent = z.enum([
  'inform',
  'decide',
  'produce',
  'transform',
  'act',
  'locate',
  'converse',
  'control',
]);
export type MacroIntent = z.infer<typeof MacroIntent>;

// The domain dictionary — seeded from Anthropic Clio's empirical usage clusters; project-declared, never coined.
export const DomainDict = z.enum([
  'coding',
  'writing',
  'research',
  'data',
  'devops',
  'design',
  'business',
]);
export type DomainDict = z.infer<typeof DomainDict>;

// NOT `.strict()`: `.catchall(z.string())` admits free qualifiers (`lang`, `framework`) as string→string while
// the two LOAD-BEARING keys (`intent`, `domain`) stay closed enums (cannot typo-drift silently).
const ServesBlock = z
  .object({
    intent: MacroIntent,
    domain: DomainDict.optional(),
    stakes: z.enum(['low', 'high']).optional(),
  })
  .catchall(z.string());
export type ServesBlock = z.infer<typeof ServesBlock>;

/** A pack may serve one cell (a block) or several (a non-empty list). */
export const Serves = z.union([ServesBlock, z.array(ServesBlock).min(1)]);

export const PackV2 = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    scope: PackScope,
    detected_by: z.array(z.unknown()).default([]),
    // ORCH.1: additive optional — a `serves`-less pack parses byte-identically (only the orchestrator reads it).
    serves: Serves.optional(),
    // ← NOW OPTIONAL: a behavior pack has `fsm`; a conformance/foundation pack does not (M.1).
    fsm: FsmV2.optional(),
    // HAR.1: a FLAT registry of named ISOLATED nested machines; a `sub_flow.flow` is a key into this.
    flows: z.record(z.string(), FsmV2).optional(),
    guards: z.record(z.string(), z.string()).default({}), // FAC-CUT.2: guard ref → an `if:`-expression (boolean predicate); the gate's block/halt action is on the state's on_fail
    messages: z.record(z.string(), z.string()).default({}), // self-continue store: failure_type → instruction
    foundation: z.unknown().optional(), // pure expertise (manifest/lessons) — neither fsm nor gates
  })
  .strict(); // CONFORMANCE-RECONCILE: no `.refine` — it only guarded `fsm`+`gates`; with `gates` gone,
// `fsm`/`foundation`/`flows` are independent optionals (a pack is a behavior FSM, or foundation, or neither).
export type PackV2 = z.infer<typeof PackV2>;

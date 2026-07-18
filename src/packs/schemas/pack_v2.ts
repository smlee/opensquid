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

import { CommitGateBlock } from '../../runtime/commit_gate_evidence.js';
import { Transition } from '../../runtime/fsm.js';
import { isNode, TAXONOMY } from '../taxonomy.js';

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

// EVIDENCE-DECLARATION (generic runtime) — a single entry in a gate's `reads:` list: the ctx key this gate
// reads, rendered as the report's `Evidence:` proof line. A BARE STRING is the ctx key (its display label is
// the key minus its `<state>.` prefix, and it reads TRUE-is-good); the OBJECT form carries an explicit `label`
// and/or `expect` polarity (e.g. an `open_question` key that is GOOD when false). This moves the former
// hardcoded per-stage evidence switch out of core (v2_supply) into pack data — a non-coding pack declares its
// own evidence keys, and the runtime renders whatever the current gate declares (nothing coding-specific).
const EvidenceRef = z.union([
  z.string().min(1),
  z
    .object({
      key: z.string().min(1),
      label: z.string().min(1).optional(),
      expect: z.boolean().optional(), // the value that reads as "ok" (default true); false for a negated facet
    })
    .strict(),
]);
export type EvidenceRef = z.infer<typeof EvidenceRef>;

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
    // LANE MODEL (the #33 successor to advance-action detection) — the stage's WRITE-LANE: a path-glob
    // allowlist (minimatch, repo-relative) of the ONLY paths a mutating file-write may target while this
    // stage is current. Under automation, an out-of-lane write BLOCKS; reads never block; a stage that omits
    // `writes` declares no lane (INERT — all writes pass). Behavior-as-data: change the lane by editing YAML,
    // not TypeScript. This is SEPARATE from the completeness `guard` (which decides when the FSM advances).
    writes: z.array(z.string().min(1)).optional(),
    // STAGE-REPORTING CADENCE (behavior-as-data, moved out of core — the user's architecture: the FLOW's
    // reporting cadence lives in the PACK, opensquid provides the emit FUNCTIONS). Replaces the hardcoded
    // `STAGE` map in v2_supply.
    //   `report`  — the display label (a Stage: SCOPE / SCOPE_WRITE / PLAN / AUTHOR / CODE / DEPLOY) of the
    //               AFTER-stage report emitted when the FSM LEAVES this state. Absent ⇒ this state emits no
    //               report. The transition-precise emit + the emit functions stay in core (v2_supply).
    //   `summary` — when true, a BEFORE-stage SUMMARY ("what will be done") is emitted when the FSM ENTERS this
    //               state (the entry-edge of a transition — once per entry, not per event). Reuses `report` as
    //               its label, so a `summary:true` with no `report` is inert.
    report: z.string().min(1).optional(),
    summary: z.boolean().optional(),
    // Optional generic report enrichments for this state.
    report_phases: z.boolean().optional(),
    goal_alignment: z.boolean().optional(),
    // EVIDENCE-DECLARATION (generic runtime): the ctx keys this gate reads, rendered as the after-stage
    // report's `Evidence:` proof line. Absent ⇒ no evidence line. Replaces the deleted hardcoded per-stage
    // `stageEvidence` switch in core — the pack, not core, owns which keys prove a stage.
    reads: z.array(EvidenceRef).optional(),
    // STAGE-WORK DESCRIPTION (behavior-as-data): "what this stage works on" — rendered as the report's
    // `Next → <stage>: <does>` line and the before-stage summary's `Will: <does>`. Replaces the hardcoded
    // `NEXT_STAGE_WORK` core map — the pack owns the per-stage work text, not a closed coding-state map.
    does: z.string().min(1).optional(),
    // Optional ordered sub-phase ledger for this opaque state. The MCP writer validates against this pack data;
    // core has no distinguished implementation state or universal phase vocabulary.
    phases: z.array(z.string().min(1)).min(1).optional(),
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

// PACK-TAXONOMY — the activation CLASS (pack-taxonomy.md:32-40): HOW a pack is chosen to be active, orthogonal
// to `scope`. `always-on` = cross-cutting governance/safety (NEVER taxonomy-gated); `on-demand` = a discipline /
// lens / expert, gated by the classified request coordinates (the bulk of packs + all lenses); `project-scoped`
// = a pack bound to a project marker. A pack declares `activation:`; a pack that omits it defaults to `on-demand`
// (pack-taxonomy.md:39). Additive metadata surfaced on the loaded pack; the on-demand CLASSIFIER that consumes it
// for containment-gated activation is a later step (#37) — for now the field validates at load and is threaded
// through as a property of PackV2.
export const Activation = z.enum(['always-on', 'on-demand', 'project-scoped']);
export type Activation = z.infer<typeof Activation>;

// Optional project-scoped policy for the interactive coordinator. StageProcess authority remains pack-owned.
const Discipline = z
  .object({
    coordinator_docs_only: z.boolean().default(false),
  })
  .strict();
export type Discipline = z.infer<typeof Discipline>;

// AUTOMATION DECLARATION — stage identifiers are opaque pack data. Core owns only the generic mechanics:
// which state is the first process-driven state and which states receive disposable StageProcess attempts.
// Meanings, names, order, human boundaries, and completion remain entirely in the pack FSM.
const TransitionReaction = z.enum([
  'freeze_captured_ask',
  'reset_captured_ask',
  'reconcile_decomposition',
  'ensure_acceptance',
  'reset_verification_loop',
]);
const Reactions = z
  .object({
    on_enter: z.record(z.string(), z.array(TransitionReaction).min(1)).optional(),
    on_leave: z.record(z.string(), z.array(TransitionReaction).min(1)).optional(),
  })
  .strict();
export type Reactions = z.infer<typeof Reactions>;

const Automation = z
  .object({
    entry: z.string().min(1),
    stages: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Automation = z.infer<typeof Automation>;

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

// The ROOT domain a project/classifier declares — the TOP-LEVEL nodes of the ONE canonical dictionary
// (`src/packs/taxonomy.ts`), derived from it so there is no second enum to drift (the single-source discipline
// taxonomy.ts:8-11 mandates). A dotted sub-domain (`coding.frontend`) is DERIVED by `classify` from this root.
const DOMAIN_ROOTS = Object.keys(TAXONOMY.domain ?? {}) as [string, ...string[]];
export const DomainDict = z.enum(DOMAIN_ROOTS);
export type DomainDict = z.infer<typeof DomainDict>;

// ORCH/pack-taxonomy — a `domain` COORDINATE is a DOTTED dictionary node (`coding`, `coding.frontend`,
// `coding.frontend.react`), validated against the canonical dictionary (`src/packs/taxonomy.ts`) at LOAD time:
// an off-dictionary node FAILS LOUD (you cannot declare a made-up category — the guess-free discipline). The
// flat roots ARE the `DomainDict` values above (same `TAXONOMY.domain` keys), so every root-only `domain: coding`
// parses identically as both a root and a node; deeper nodes (`coding.frontend`) address sub-domains.
const DomainNode = z.string().refine((s) => isNode('domain', s), {
  message: 'off-dictionary domain node (see src/packs/taxonomy.ts)',
});

// NOT `.strict()`: `.catchall(z.string())` admits free qualifiers (`lang`, `framework`) as string→string while
// the LOAD-BEARING keys (`intent`, `domain`) stay validated (cannot typo-drift silently).
const ServesBlock = z
  .object({
    intent: MacroIntent,
    domain: DomainNode.optional(),
    stakes: z.enum(['low', 'high']).optional(),
  })
  .catchall(z.string());
export type ServesBlock = z.infer<typeof ServesBlock>;

/** A pack may serve one cell (a block) or several (a non-empty list). */
export const Serves = z.union([ServesBlock, z.array(ServesBlock).min(1)]);

// ORCH/fractal — a SKILL's `serves`: the SAME closed facet vocabulary a pack declares, but EVERY key optional.
// A lens discipline gates by only the facets it cares about — chiefly the dotted `domain` node, whose coding
// sub-domains (`coding.frontend`, `coding.backend`) are how a sub-domain lens addresses its slice — and is
// INTENT-AGNOSTIC: a frontend lens applies whether the turn is `produce` or `inform`. Hierarchical subset-match
// (the same `blockMatch` the pack matcher uses): the skill fires only when every key it declares CONTAINS the
// classified turn's facet. A skill with NO `serves` is the always-on core spine (ungated).
const SkillServesBlock = z
  .object({
    intent: MacroIntent.optional(),
    domain: DomainNode.optional(),
    stakes: z.enum(['low', 'high']).optional(),
  })
  .catchall(z.string());
export type SkillServesBlock = z.infer<typeof SkillServesBlock>;
/** A skill may gate on one facet-cell or several (a non-empty list — OR semantics, like the pack `Serves`). */
export const SkillServes = z.union([SkillServesBlock, z.array(SkillServesBlock).min(1)]);
export type SkillServes = z.infer<typeof SkillServes>;

// AGF.1 (T-opensquid-automated-gitflow) — the pack-declared default versioning strategy shape. Mirrors
// discovery.ts `VersioningConfig` (the project-config sibling): `strategy`/`bump` single-member unions today,
// `prefix` the human-held major.minor.
const VersioningStrategy = z.object({
  strategy: z.literal('locked-prefix'),
  prefix: z.string().min(1),
  bump: z.literal('patch-per-release').default('patch-per-release'),
});

// Audit channels exposed to guard expressions. Channel ids are opaque pack data; each binding names its cache,
// producer rule, rubric file, and optional exact-byte approved-artifact freshness policy.
const AuditBinding = z
  .object({
    cache_key: z.string().min(1),
    rule: z.string().min(1),
    rubric: z.string().min(1),
    subject: z.enum(['cache', 'approved_artifact']).default('cache'),
    writes: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type AuditBinding = z.infer<typeof AuditBinding>;

export const PackV2 = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    scope: PackScope,
    // PACK-TAXONOMY activation class (default `on-demand`, pack-taxonomy.md:39). Validated at load (Zod enum).
    activation: Activation.default('on-demand'),
    // DISCIPLINE-DECLARATION — the machine-behaviour policy this pack imposes (currently: orchestrator-only).
    // Optional; absent ⇒ no declared discipline ⇒ the substrate's orchestrator guard does NOT fire for a project
    // whose packs are all declaration-less (e.g. a content/SEO project).
    discipline: Discipline.optional(),
    detected_by: z.array(z.unknown()).default([]),
    // ORCH.1: additive optional — a `serves`-less pack parses byte-identically (only the orchestrator reads it).
    serves: Serves.optional(),
    // ← NOW OPTIONAL: a behavior pack has `fsm`; a conformance/foundation pack does not (M.1).
    fsm: FsmV2.optional(),
    // Pack-owned process-driving policy. The strings are references into `fsm.states`; core never assigns
    // semantics to them. Omit for packs that are not driven by the deterministic outer coordinator.
    automation: Automation.optional(),
    reactions: Reactions.optional(),
    // HAR.1: a FLAT registry of named ISOLATED nested machines; a `sub_flow.flow` is a key into this.
    flows: z.record(z.string(), FsmV2).optional(),
    guards: z.record(z.string(), z.string()).default({}), // FAC-CUT.2: guard ref → an `if:`-expression (boolean predicate); the gate's block/halt action is on the state's on_fail
    messages: z.record(z.string(), z.string()).default({}), // self-continue store: failure_type → instruction
    audits: z.record(z.string(), AuditBinding).optional(),
    // COMMIT-GATE EVIDENCE (T-deploy-commit-gate scope-4, design §4a) — a discipline pack DECLARES which
    // session-state keys the generic CORE commit-gate reads to authorize a code commit, so core carries no
    // `fullstack-flow-*` key literal. Optional/additive: a pack that omits it (v1 `coding-flow`) keeps the
    // session-FSM gate path. The reader (runtime/commit_gate_evidence.ts) resolves this block module-relative.
    commit_gate: CommitGateBlock.optional(),
    // AGF.1 (T-opensquid-automated-gitflow) — the PACK-declared default VERSIONING strategy for the automated
    // git-flow: the recommended default a project inherits when its active.json omits `versioning` (project-over-
    // pack override). Optional/additive: a pack that omits it keeps no default (core then needs the project object).
    // The `prefix` literal lives HERE (data), never in core logic.
    versioning: VersioningStrategy.optional(),
    foundation: z.unknown().optional(), // pure expertise (manifest/lessons) — neither fsm nor gates
  })
  .strict()
  // ORCH.8 — propose/dispose entry-guard: a `serves`-bearing pack with an `fsm` MUST start at a `gate` state, so a
  // routed pack RE-VERIFIES its own fit on entry and a misroute can never run the wrong workflow to completion.
  // Fires ONLY when `serves` + `fsm` are both present — fsm-only and serves-only (foundation) packs are unaffected.
  .superRefine((p, ctx) => {
    if (
      p.serves !== undefined &&
      p.fsm !== undefined &&
      p.fsm.states[p.fsm.initial]?.kind !== 'gate'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fsm', 'initial'],
        message:
          "ORCH.8: a serves-bearing pack's fsm must start at a `gate` state (the entry fit-guard)",
      });
    }
    if (p.reactions !== undefined) {
      if (p.fsm === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reactions'],
          message: 'transition reactions require an fsm',
        });
      } else {
        for (const [edge, bindings] of Object.entries(p.reactions)) {
          for (const stageId of Object.keys(bindings ?? {})) {
            if (p.fsm.states[stageId] === undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['reactions', edge, stageId],
                message: `reaction state '${stageId}' is not an fsm state`,
              });
            }
          }
        }
      }
    }
    if (p.automation === undefined) return;
    if (p.fsm === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['automation'],
        message: 'automation requires an fsm',
      });
      return;
    }
    const declared = new Set(p.automation.stages);
    if (declared.size !== p.automation.stages.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['automation', 'stages'],
        message: 'automation stages must be unique',
      });
    }
    if (!declared.has(p.automation.entry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['automation', 'entry'],
        message: 'automation entry must be included in automation stages',
      });
    }
    for (const [index, stageId] of p.automation.stages.entries()) {
      const state = p.fsm.states[stageId];
      if (state === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['automation', 'stages', index],
          message: `automation stage '${stageId}' is not an fsm state`,
        });
      } else if (state.kind === 'terminal') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['automation', 'stages', index],
          message: `automation stage '${stageId}' cannot be terminal`,
        });
      }
    }
  });
export type PackV2 = z.infer<typeof PackV2>;

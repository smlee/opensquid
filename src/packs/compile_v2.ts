/**
 * compile_v2 — lower a PackV2 (FSM-primary pack) to the reused `runtime/fsm.ts`
 * engine machine + a per-state metadata table for the loop driver (LOOP.1).
 *
 * The engine (`fsm.ts`) is reused as-is: it owns states + transitions + the
 * total `step`. STRUCTURE (the `{from,on,to}[]` named-event edges) is AUTHORED
 * explicitly in `pack.fsm.transitions` — the compiler does NO event synthesis.
 * BEHAVIOR (kind, executor, skills, guards, the on-fail action, branches,
 * sub-flow ref, outcome, and the NAMED event each state emits) lives in
 * `StateMeta` — the loop driver reads `meta[state]` to decide
 * spawn-vs-evaluate-vs-branch, then advances on the state's `emits` event.
 *
 * Events are author-NAMED (the live `advance_fsm` semantics): an executor emits
 * its `emits` event on completion; a gate emits `on_pass_emits` on pass (or the
 * `on_fail` action); a decision emits the first-matching branch's `emits`; a
 * sub-flow emits on its nested terminal. A gate's optional `trigger` names the
 * OBSERVED events that evaluate it (the conformance case). The compiler verifies
 * every driver-emitted event has a routing transition (no silent dead end).
 *
 * Spec: loop/docs/tasks/T-fsm-actor-rescope.md §T1.
 */
import type { ProcessStep } from '../runtime/types.js';
import { validateFsm, type Fsm } from '../runtime/fsm.js';
import type { PackV2, StateKind, DecisionBranch } from './schemas/pack_v2.js';

export interface StateMeta {
  kind: StateKind;
  // executor
  executor?: string;
  skills: string[];
  directive?: string;
  completion?: string;
  // executor / gate(on_pass) / sub_flow: the NAMED event the driver fires to advance
  emits?: string;
  // gate
  guard?: string;
  trigger?: string[]; // observed events that evaluate the gate (conformance); absent = driver-evaluated
  onFail?: { action: 'block' | 'halt'; message: string };
  // decision
  branches?: DecisionBranch[];
  // sub_flow
  flow?: string;
  // terminal
  outcome?: 'shipped' | 'wedge';
}

/** A conformance gate lowered to the descriptor its EXISTING evaluator consumes (M.1 adds NO new logic):
 *  track_check → `evaluateProcess`; destination_check → the scheduler + `check_destination`. */
export type CompiledGate =
  | {
      kind: 'track_check';
      trigger: string[];
      process: ProcessStep[];
      onFail?: { action: 'warn' | 'block' | 'halt'; message: string };
    }
  | {
      kind: 'destination_check';
      promptTemplate: string;
      everyN: number;
      modelAlias?: string;
      onFail?: { action: 'warn' | 'block' | 'halt'; message: string };
    };

export interface CompiledPack {
  fsm?: Fsm; // states + transitions in the reused engine's format (present only for the behavior form)
  meta: Record<string, StateMeta>; // per-state behavior for the loop driver (empty for non-fsm forms)
  gates?: CompiledGate[]; // conformance form: each lowered to its evaluator's descriptor
}

export function compilePackV2(pack: PackV2): CompiledPack {
  // BEHAVIOR form: present only when the pack carries an `fsm` (a conformance/foundation pack does not).
  const meta: Record<string, StateMeta> = {};
  let fsm: Fsm | undefined;
  if (pack.fsm !== undefined) {
    const fsmDef = pack.fsm;
    // STRUCTURE: the transitions are AUTHORED, not synthesized. Reuse them verbatim.
    fsm = {
      initial: fsmDef.initial,
      states: Object.keys(fsmDef.states),
      transitions: fsmDef.transitions,
    };
    // ENFORCE totality at compile (mirrors the v1 loader.ts:374): a dangling `to`/`from`/`initial`
    // fails LOUD here, not silently deferred to a consumer that may never call validateFsm.
    const errors = validateFsm(fsm);
    if (errors.length > 0) {
      throw new Error(`pack ${pack.name}: invalid FSM — ${errors.join('; ')}`);
    }

    // BEHAVIOR: per-state metadata + the NAMED event each state emits.
    const emitted = new Set<string>(); // every driver-emitted event (must be routed)
    for (const [name, s] of Object.entries(fsmDef.states)) {
      switch (s.kind) {
        case 'executor':
          meta[name] = {
            kind: s.kind,
            // conditional spread: under exactOptionalPropertyTypes, an absent executor must be omitted, not `undefined`
            ...(s.executor !== undefined ? { executor: s.executor } : {}),
            skills: s.skills,
            directive: s.directive,
            completion: s.completion,
            emits: s.emits,
          };
          emitted.add(s.emits);
          break;
        case 'gate':
          // on_pass_emits advances; on_fail is an ACTION (block/halt + self-continue), NOT a transition.
          meta[name] = {
            kind: s.kind,
            skills: [],
            guard: s.guard,
            onFail: s.on_fail,
            emits: s.on_pass_emits,
            ...(s.trigger !== undefined ? { trigger: s.trigger } : {}),
          };
          emitted.add(s.on_pass_emits);
          break;
        case 'decision':
          // a decision's branch emits must be pairwise-distinct: step() routes by (from,on), so two
          // branches emitting the same event would collide on one target (an unreachable branch — silent).
          assertDistinctBranchEmits(pack.name, name, s.branches);
          meta[name] = { kind: s.kind, skills: [], branches: s.branches };
          for (const b of s.branches) emitted.add(b.emits);
          break;
        case 'sub_flow':
          meta[name] = { kind: s.kind, skills: [], flow: s.flow, emits: s.emits };
          emitted.add(s.emits);
          break;
        case 'terminal':
          // terminal emits nothing.
          meta[name] = { kind: s.kind, skills: [], outcome: s.outcome };
          break;
      }
    }

    // ENFORCE: every DRIVER-emitted event must have a routing transition (an unrouted emit is a dead end).
    const routed = new Set(fsmDef.transitions.map((t) => t.on));
    const unrouted = [...emitted].filter((e) => !routed.has(e));
    if (unrouted.length > 0) {
      throw new Error(`pack ${pack.name}: emitted but unrouted events — ${unrouted.join(', ')}`);
    }
  }

  // CONFORMANCE form: lower each gate to its EXISTING evaluator's descriptor (re-shape only, no new logic).
  const gates: CompiledGate[] | undefined = pack.gates?.map((g) =>
    g.kind === 'track_check'
      ? {
          kind: g.kind,
          trigger: g.trigger,
          process: g.process,
          ...(g.on_fail !== undefined ? { onFail: g.on_fail } : {}),
        }
      : {
          kind: g.kind,
          promptTemplate: g.prompt_template,
          everyN: g.every_n_tool_calls,
          ...(g.model_alias !== undefined ? { modelAlias: g.model_alias } : {}),
          ...(g.on_fail !== undefined ? { onFail: g.on_fail } : {}),
        },
  );

  // FOUNDATION form: neither fsm nor gates → a CompiledPack with empty meta + no gates (pure expertise).
  return { ...(fsm !== undefined ? { fsm } : {}), meta, ...(gates !== undefined ? { gates } : {}) };
}

/** Fail LOUD if a decision's branches emit a duplicate event (would make a branch unreachable via routing). */
function assertDistinctBranchEmits(pack: string, state: string, branches: DecisionBranch[]): void {
  const seen = new Set<string>();
  for (const b of branches) {
    if (seen.has(b.emits)) {
      throw new Error(`pack ${pack}: decision '${state}' has duplicate branch emit '${b.emits}'`);
    }
    seen.add(b.emits);
  }
}

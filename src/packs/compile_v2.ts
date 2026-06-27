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
  onFail?: { action: 'warn' | 'block' | 'halt'; message: string };
  // decision
  branches?: DecisionBranch[];
  // sub_flow
  flow?: string;
  // terminal
  outcome?: 'shipped' | 'wedge';
}

export interface CompiledPack {
  fsm?: Fsm; // states + transitions in the reused engine's format (present only for the behavior form)
  meta: Record<string, StateMeta>; // per-state behavior for the loop driver (empty for non-fsm forms)
  flows?: Record<string, CompiledPack>; // HAR.1: compiled ISOLATED nested machines (sub_flow targets)
  guardExprs?: Map<string, string>; // FAC-CUT.2: guard ref → `if:`-expression (behavior form); the RegistryGuardEvaluator's source
}

/** Compile ONE machine (fsm + meta + gates) — does NOT touch `flows` (no recursion). The HAR.1 wrapper
 *  `compilePackV2` compiles each flow via this + shares the flat registry. */
function compileMachine(pack: PackV2): CompiledPack {
  // BEHAVIOR form: present only when the pack carries an `fsm` (a conformance/foundation pack does not).
  const meta: Record<string, StateMeta> = {};
  let fsm: Fsm | undefined;
  let guardExprs: Map<string, string> | undefined;
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

    // FAC-CUT.2: every gate/decision guard ref must resolve in the pack's `guards` registry (an
    // `if:`-expression). Fail LOUD here (mirrors validateFsm) — a dangling ref is a pack bug, never a
    // silent skip. This runs inside compileMachine, so each `flows` machine is covered too (compilePackV2
    // calls compileMachine per flow with the same pack.guards).
    guardExprs = new Map<string, string>(Object.entries(pack.guards));
    const guardRefs: string[] = [];
    for (const s of Object.values(fsmDef.states)) {
      if (s.kind === 'gate') guardRefs.push(s.guard);
      else if (s.kind === 'decision')
        for (const b of s.branches) if ('guard' in b) guardRefs.push(b.guard);
    }
    for (const ref of guardRefs) {
      if (!guardExprs.has(ref)) {
        throw new Error(`pack ${pack.name}: guard ref '${ref}' not in the guards registry`);
      }
    }
  }

  // FOUNDATION form: neither fsm nor gates → a CompiledPack with empty meta (pure expertise).
  return {
    ...(fsm !== undefined ? { fsm } : {}),
    meta,
    ...(guardExprs !== undefined ? { guardExprs } : {}),
  };
}

/**
 * HAR.1 — compile a pack + its FLAT `flows` registry of isolated nested machines. Each flow is compiled
 * via `compileMachine` (NON-recursive — no re-entry into `flows`); a fail-loud sweep checks every
 * `sub_flow.flow` (parent + each flow) resolves to a registered flow; the flat registry is SHARED onto
 * every compiled machine so a child driver can resolve sibling flows.
 */
export function compilePackV2(pack: PackV2): CompiledPack {
  const compiled = compileMachine(pack);
  if (pack.flows !== undefined) {
    const flows: Record<string, CompiledPack> = {};
    for (const [name, f] of Object.entries(pack.flows))
      flows[name] = compileMachine({ ...pack, fsm: f });
    // fail-loud (FLAT, non-recursive sweep): when a registry is declared, every sub_flow.flow across the
    // parent + each flow must resolve to a registered flow. (A sub_flow with NO registry at all is caught
    // at RUNTIME by the driver's fail-loud — `runSubFlow` throws on an unresolved child — so a registry-
    // less pack still graphs/round-trips in tools like viz without a compile error.)
    const registered = new Set(Object.keys(pack.flows));
    for (const machine of [pack.fsm, ...Object.values(pack.flows)]) {
      for (const [st, s] of Object.entries(machine?.states ?? {})) {
        if (s.kind === 'sub_flow' && !registered.has(s.flow)) {
          throw new Error(
            `pack ${pack.name}: sub_flow '${st}' -> flow '${s.flow}' resolves to no registered nested machine`,
          );
        }
      }
    }
    compiled.flows = flows;
    for (const child of Object.values(flows)) child.flows = flows; // share the flat registry (sibling resolution)
  }
  return compiled;
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

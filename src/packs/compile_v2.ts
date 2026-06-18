/**
 * compile_v2 — lower a PackV2 (FSM-primary pack) to the reused `runtime/fsm.ts`
 * engine machine + a per-state metadata table for the loop driver (LOOP.1).
 *
 * The engine (`fsm.ts`) is reused as-is: it owns states + transitions + the
 * total `step`. The per-state behavior (kind, executor, skills, guards, the
 * on-fail action, branches, sub-flow ref, outcome) lives in `StateMeta` — the
 * loop driver reads `meta[state]` to decide spawn-vs-evaluate-vs-branch.
 *
 * Reserved synthetic events (the `__` prefix is reserved, never author-defined):
 *   `__complete:<s>`  executor-state completion guard held → transition
 *   `__pass:<s>`      gate-state guard passed → transition
 *   `__branch:<s>:<i>`  decision branch i taken
 *   `__subflow_done:<s>`  sub-flow reached terminal → parent transition
 *
 * Spec: loop/docs/tasks/T-fsm-actor-runtime.md §PFV2.1.
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
  // gate
  guard?: string;
  onFail?: { action: 'block' | 'halt'; message: string };
  // decision
  branches?: DecisionBranch[];
  // sub_flow
  flow?: string;
  // terminal
  outcome?: 'shipped' | 'wedge';
}

export interface CompiledPack {
  fsm: Fsm; // states + transitions in the reused engine's format (passes validateFsm)
  meta: Record<string, StateMeta>; // per-state behavior for the loop driver
}

export function compilePackV2(pack: PackV2): CompiledPack {
  const transitions: Fsm['transitions'] = [];
  const meta: Record<string, StateMeta> = {};
  for (const [name, s] of Object.entries(pack.fsm.states)) {
    switch (s.kind) {
      case 'executor':
        transitions.push({ from: name, on: `__complete:${name}`, to: s.next });
        meta[name] = {
          kind: s.kind,
          // conditional spread: under exactOptionalPropertyTypes, an absent executor must be omitted, not `undefined`
          ...(s.executor !== undefined ? { executor: s.executor } : {}),
          skills: s.skills,
          directive: s.directive,
          completion: s.completion,
        };
        break;
      case 'gate':
        // on_pass is a transition; on_fail is an ACTION (block/halt + self-continue), NOT a transition.
        transitions.push({ from: name, on: `__pass:${name}`, to: s.on_pass.to });
        meta[name] = { kind: s.kind, skills: [], guard: s.guard, onFail: s.on_fail };
        break;
      case 'decision':
        s.branches.forEach((b, i) =>
          transitions.push({ from: name, on: `__branch:${name}:${i}`, to: b.to }),
        );
        meta[name] = { kind: s.kind, skills: [], branches: s.branches };
        break;
      case 'sub_flow':
        transitions.push({ from: name, on: `__subflow_done:${name}`, to: s.on_complete.to });
        meta[name] = { kind: s.kind, skills: [], flow: s.flow };
        break;
      case 'terminal':
        // terminal emits no transition.
        meta[name] = { kind: s.kind, skills: [], outcome: s.outcome };
        break;
    }
  }
  const fsm: Fsm = { initial: pack.fsm.initial, states: Object.keys(pack.fsm.states), transitions };
  // ENFORCE totality at compile (mirrors the v1 loader.ts:374): a dangling `next`/`to`/`initial`
  // fails LOUD here, not silently deferred to a consumer that may never call validateFsm.
  const errors = validateFsm(fsm);
  if (errors.length > 0) {
    throw new Error(`pack ${pack.name}: invalid FSM — ${errors.join('; ')}`);
  }
  return { fsm, meta };
}

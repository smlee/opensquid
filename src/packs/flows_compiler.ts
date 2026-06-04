/**
 * T-FC2-FLOW-TEMPLATES — `flows:` → FSM-fragment expansion (B2: the FLOW half of
 * the reusable-template thesis; the gate half is `guards:`/`guards_compiler`).
 *
 * A flow is a `{template, params}` invocation that a pure expander turns into an
 * FSM `{states, transitions}` fragment, merged into the hand-authored `fsm.yaml`
 * machine BEFORE `validateFsm` so totality is checked on the EXPANDED FSM. Mirrors
 * `guards_compiler`'s contract: a FLAT template registry, fail-LOUD on an unknown
 * template or invalid params (no silent skip).
 *
 * First template: `loopback_gate` — a quality-gate re-do edge (e.g. the guess-audit
 * loop `researched --guess_found--> researching`). FSM-only (no skills); the
 * block-while-state pattern is already covered by `guards:`.
 *
 * Pure: no I/O. Imported by: `loader.ts` (at the fsm-load site).
 */
import type { Transition } from '../runtime/fsm.js';
import type { Flow } from './schemas/manifest.js';

export interface FlowExpansion {
  states: string[];
  transitions: Transition[];
}

type ExpandResult = { ok: true; expansion: FlowExpansion } | { ok: false; error: string };

/**
 * Pure params→fragment expanders. A new template is purely additive here — no
 * generalization of this signature until a 2nd/3rd template earns it (the n=1
 * discipline: the abstraction stays shaped by concrete instances).
 */
const FLOW_TEMPLATES: Record<string, (params: Record<string, unknown>) => ExpandResult> = {
  // loopback_gate: being in `state`, a `trigger` (e.g. an audit-fail) loops back to
  // `back_to` to redo the region. A loop-back connects two EXISTING spine states, so
  // it contributes only the edge — both endpoints MUST already be declared in
  // fsm.yaml. validateFsm (run on the merged machine) then catches a typo'd endpoint.
  loopback_gate: (params) => {
    const { state, trigger, back_to } = params;
    if (typeof state !== 'string' || typeof trigger !== 'string' || typeof back_to !== 'string') {
      return {
        ok: false,
        error: 'loopback_gate requires string params { state, trigger, back_to }',
      };
    }
    return {
      ok: true,
      expansion: { states: [], transitions: [{ from: state, on: trigger, to: back_to }] },
    };
  },
};

export type CompileFlowsResult =
  | { ok: true; expansion: FlowExpansion }
  | { ok: false; errors: string[] };

/**
 * Compile a pack's `flows` into one merged `{states, transitions}` fragment.
 * Empty `flows` → an empty (no-op) expansion. An unknown template or invalid
 * params is collected (prefixed with the pack name) and surfaced as
 * `{ok:false, errors}` — never silently dropped (mirrors `compileGuards`).
 */
export function compileFlows(packName: string, flows: readonly Flow[]): CompileFlowsResult {
  const errors: string[] = [];
  const states: string[] = [];
  const transitions: Transition[] = [];

  for (const flow of flows) {
    const expander = FLOW_TEMPLATES[flow.template];
    if (expander === undefined) {
      errors.push(
        `pack ${packName}: unknown flow template "${flow.template}" (known: ${Object.keys(FLOW_TEMPLATES).join(', ')})`,
      );
      continue;
    }
    const result = expander(flow.params);
    if (!result.ok) {
      errors.push(`pack ${packName}: ${flow.template}: ${result.error}`);
      continue;
    }
    for (const s of result.expansion.states) if (!states.includes(s)) states.push(s);
    transitions.push(...result.expansion.transitions);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, expansion: { states, transitions } };
}

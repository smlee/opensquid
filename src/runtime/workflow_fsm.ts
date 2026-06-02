/**
 * T-PACK-FSM-STANDARDIZATION slice A — the 7-phase workflow as a declared FSM.
 *
 * This models `chain_state.ts`'s pipeline (the same 7 stages, same forward
 * order) as data the generic `fsm.ts` engine runs — the preset slice A2 will
 * wire in to REPLACE the hardcoded `transitionChainStage` + its 5 scattered
 * call-sites. Two things it gains over `chain_state` immediately:
 *
 *   1. TOTALITY — `validateFsm` proves every transition lands on a real state;
 *      the runner defines an outcome for every (state, event). `chain_state`'s
 *      `transitionChainStage` accepts ANY target with no legality check.
 *   2. LOOP-BACK — `researched --guess_found--> scoping` is an explicit edge.
 *      `chain_state` is forward-only (its `idle→scoping` writer even guards
 *      AGAINST regression), so it structurally cannot re-enter research when an
 *      unresolved guess is found. That backward edge is exactly what the scope
 *      guess-prevention gate (slice C) loops on.
 */
import type { Fsm } from './fsm.js';

/** Stage order matches `chain_state.ts` CHAIN_STAGES (parity-tested). */
export const WORKFLOW_FSM: Fsm = {
  initial: 'idle',
  states: [
    'idle',
    'scoping',
    'researched',
    'spec_authored',
    'tasks_loaded',
    'phases_in_flight',
    'phases_complete',
  ],
  transitions: [
    { from: 'idle', on: 'scope_start', to: 'scoping' },
    { from: 'scoping', on: 'research_done', to: 'researched' },
    // The loop-back chain_state cannot express: an unresolved guess sends the
    // workflow back to scoping/research (slice C drives this edge).
    { from: 'researched', on: 'guess_found', to: 'scoping' },
    { from: 'researched', on: 'spec_authored', to: 'spec_authored' },
    { from: 'spec_authored', on: 'tasks_loaded', to: 'tasks_loaded' },
    { from: 'tasks_loaded', on: 'phase_started', to: 'phases_in_flight' },
    { from: 'phases_in_flight', on: 'phases_done', to: 'phases_complete' },
  ],
};

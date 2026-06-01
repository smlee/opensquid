/**
 * Workflow forward-map (T-FLOW-COHESION FC.2) — the SINGLE source of "given the
 * current chain-stage, what is the next step." When a gate blocks, the hook
 * folds this map into the deny message so the agent is pointed FORWARD at the
 * wall (current stage + next step) instead of bouncing backward through
 * prerequisites. Reads the chain-state FSM, which FC.1 made atomic/trustworthy,
 * so no degradation branch is needed — `idle` is a real, correct stage.
 *
 * `STAGE_NEXT` is the canonical stage→next-step text. The `chain-handoffs` skill
 * (prompt_submit reinforcement) describes the same pipeline; this is the
 * authoritative source — keep that skill's rationale consistent with it.
 *
 * Imports from: ./chain_state.js.
 * Imported by: src/runtime/hooks/pre-tool-use.ts (block path).
 */

import { type ChainStage, readChainState } from './chain_state.js';

/** Canonical next step for each pipeline stage. Exhaustive over `ChainStage`
 *  (the compiler enforces every stage has an entry). */
export const STAGE_NEXT: Record<ChainStage, string> = {
  idle: 'no active scope — scope it first: write the pre-research doc (docs/research/<slug>-pre-research-*.md)',
  scoping: 'write the pre-research doc (docs/research/<slug>-pre-research-*.md)',
  researched:
    'author the track spec via the task-spec-author profession (consume the pre-research)',
  spec_authored: 'TaskCreate each "### Task" with metadata.spec = the spec\'s absolute path',
  tasks_loaded: 'set the task in_progress, then log_phase through the 7 phases as you work',
  phases_in_flight: 'resume at the next unlogged phase; log_phase as each of the 7 completes',
  phases_complete: 'workflow complete for the active task — the terminal action is allowed',
};

const PATH_LINE = 'Workflow: pre_research → spec → tasks → 7 phases → commit';

/**
 * The compact forward map for a session's current stage: the path, where you
 * are, and the single next step. Fail-open: a read error resolves to `idle`
 * (the correct fresh-session stage), never throws.
 */
export async function forwardMap(sessionId: string): Promise<string> {
  const stage: ChainStage = (await readChainState(sessionId).catch(() => null))?.stage ?? 'idle';
  return `${PATH_LINE}\nYou are at: ${stage}\nNext: ${STAGE_NEXT[stage]}`;
}

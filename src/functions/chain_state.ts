/**
 * `read_chain_state` primitive (T-ASC, ASC.5).
 *
 * Exposes the persisted T-ASC chain-state (or an idle-default shape) to
 * skill YAML `process:` chains. Used by ASC.5's reframed scope-decomposer
 * chain-handoff rules to read enrichment fields (`pre_research_path`,
 * `spec_path`, `task_ids`) when shaping the structured `directive`
 * verdict's `next_action.args`.
 *
 * Returns a stable shape: a non-null object that always has `stage`
 * (defaulting to `'idle'`) and `history` (defaulting to `[]`), plus
 * optional enrichment fields. The `if:` grammar's field access is
 * dot-notation; a stable shape means rule expressions like
 * `chain.pre_research_path` never trigger an undefined-access on the
 * absent-file path.
 *
 * Side-effect-free, no-throw — the underlying `readChainState` returns
 * null on absent/malformed; this primitive coalesces to the idle-default
 * shape. `memoizable: false` because the chain state changes between
 * turns (writers fire on UserPromptSubmit, PreToolUse, log_phase) — a
 * memoized stage would mask the very transitions we're reading.
 *
 * `durable: false` (pure read, cheap stat+readFile). `costEstimateMs: 1`.
 *
 * Imports from: zod, ../runtime/chain_state.js, ../runtime/result.js,
 *   ./registry.js.
 * Imported by: src/runtime/bootstrap.ts (registry wiring).
 */

import { z } from 'zod';

import { readChainState, type ChainStage } from '../runtime/chain_state.js';
import { ok } from '../runtime/result.js';

import type { FunctionDef } from './registry.js';

const NoArgs = z.object({}).strict();
type NoArgs = z.input<typeof NoArgs>;

/**
 * The primitive's output shape. `stage` is always present (defaults to
 * 'idle' when no chain file exists). Enrichment fields are optional and
 * appear when their writers populated them.
 */
export interface ReadChainStateOutput {
  stage: ChainStage;
  history: { stage: ChainStage; at: string }[];
  pre_research_path?: string;
  spec_path?: string;
  task_ids?: string[];
}

export const ReadChainState: FunctionDef<NoArgs, ReadChainStateOutput> = {
  name: 'read_chain_state',
  argSchema: NoArgs,
  durable: false,
  memoizable: false,
  costEstimateMs: 1,
  execute: async (_args, ctx) => {
    const state = await readChainState(ctx.sessionId);
    if (state === null) {
      // Idle-default shape: callers can always access `chain.stage` and
      // `chain.history` without an undefined check. Enrichment fields
      // remain absent (not undefined — the field simply isn't on the
      // object), so the `if:` grammar's existence checks work correctly.
      return ok({ stage: 'idle' as const, history: [] });
    }
    return ok({
      stage: state.stage,
      history: state.history,
      ...(state.pre_research_path !== undefined
        ? { pre_research_path: state.pre_research_path }
        : {}),
      ...(state.spec_path !== undefined ? { spec_path: state.spec_path } : {}),
      ...(state.task_ids !== undefined ? { task_ids: state.task_ids } : {}),
    });
  },
};

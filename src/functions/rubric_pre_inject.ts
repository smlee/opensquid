/**
 * `rubric_pre_inject` primitive (T-transfer-audit-rubric TR.B, wg-2d1d8698f563).
 *
 * Delivers the coding-flow quality rubric to the agent BEFORE it authors — the fix for the
 * "blind first draft" root cause. Modeled on `recall_pre_inject`: on a `prompt_submit` event, when the
 * coding-flow FSM is in an active SCOPE/AUTHOR phase, it returns a `{ kind: 'inject_context', content }`
 * payload that `dispatch.ts` emits as Claude Code's `hookSpecificOutput.additionalContext` at UserPromptSubmit.
 *
 * Injects the FULL rubric (BOTH scope + author), NOT phase-gated to one: `prompt_submit` fires per USER PROMPT
 * while phases advance MID-TURN on writes, so under run-to-exhaustion the whole SCOPE→AUTHOR flow is one turn
 * with no intervening prompt — one injection must cover every phase the turn will traverse. The hosting rule
 * is ordered AFTER `enter-scoping` in `entry-and-handoffs` so the cold kickoff turn's just-armed `scoping` is
 * visible (rules walk file-order). If the flow isn't armed (idle / non-coding), nothing injects — and no audit
 * fires either, so no rubric is owed.
 *
 * Reuses `readRubricContent` (TR.A) — ONE canonical source for the audit AND the agent. Fail-loud has no
 * meaning here (this is advisory injection, not a gate): a null fragment simply injects nothing; the audit
 * (the blocker) fail-louds on the same condition.
 */

import { z } from 'zod';

import { readFsmStateRaw } from '../runtime/fsm_state.js';
import { ok } from '../runtime/result.js';

import { readRubricContent } from './read_rubric.js';
import type { FunctionRegistry } from './registry.js';

// Active SCOPE/AUTHOR authoring phases (packs/builtin/coding-flow/fsm.yaml:15-18). `researched` is the
// pre-spec-write window where the first spec is authored (spec_drafted fires ON the write).
const ACTIVE = new Set(['scoping', 'researching', 'researched', 'spec_authored']);

const EmptyArgs = z.object({}).strict();

export function registerRubricPreInject(registry: FunctionRegistry): void {
  registry.register({
    name: 'rubric_pre_inject',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false,
    costEstimateMs: 2,
    execute: async (_args, ctx) => {
      if (ctx.event.kind !== 'prompt_submit') return ok(null);
      const st = await readFsmStateRaw(ctx.sessionId, 'coding-flow'); // null on unstarted/unreadable
      if (st === null || !ACTIVE.has(st)) return ok(null); // FSM-active gate
      const scope = await readRubricContent('scope');
      const author = await readRubricContent('author');
      if (scope === null && author === null) return ok(null);
      const content = [
        '## Coding-flow quality rubric — the bar the SCOPE/AUTHOR gates will apply (hold it BEFORE you author)',
        '',
        '### SCOPE (pre-research / scope artifacts)',
        scope ?? '_(scope rubric unavailable)_',
        '',
        '### AUTHOR (task specs)',
        author ?? '_(author rubric unavailable)_',
      ].join('\n');
      return ok({ kind: 'inject_context' as const, content });
    },
  });
}

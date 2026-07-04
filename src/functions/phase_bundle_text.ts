/**
 * phase_bundle_text (CFD.3 / PG.3) — the bindable phase-bundle primitive for inject-on-pause.
 *
 * The pause guards (pause-stop-guard / pause-prevention) must, on ANY pause, inject the completion context —
 * the current phase's procedure section + its rubric. A rule cannot both `verdict`(block/warn) AND return an
 * `inject_context` (mutually-exclusive terminals — evaluator.ts:232-253), and the DSL cannot call the bare
 * `selectPhaseBundle`. So this primitive returns the bundle as a plain BINDABLE value `{ text }` (NOT an
 * inject_context — so it binds via `as:` and does not terminate the rule); the pause rule then interpolates
 * `{{bundle.text}}` into its verdict message (evaluator.ts:539-561).
 *
 * Mirrors `phase_inject` (phase_inject.ts:89-104): reads `ctx.packProcedure` + both rubrics and calls the
 * pure `selectPhaseBundle` with the RAW FSM state (the selector maps state→phase internally,
 * select_phase_bundle.ts:80-85). CODE phases have no rubric (`:88`, "CODE→none") → procedure-only there.
 *
 * Spec: docs/tasks/T-pause-guard.md PG.3; pre-research §4.3.
 */
import { z } from 'zod';

import { readFsmStateRaw } from '../runtime/fsm_state.js';
import { ok } from '../runtime/result.js';

import { readRubricContent } from './read_rubric.js';
import type { FunctionRegistry } from './registry.js';
import { selectPhaseBundle } from './select_phase_bundle.js';

const EmptyArgs = z.object({}).strict();

export function registerPhaseBundleText(registry: FunctionRegistry): void {
  registry.register({
    name: 'phase_bundle_text',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false, // re-read each call so a rubric/procedure edit is reflected
    costEstimateMs: 3,
    execute: async (_args, ctx) => {
      // No procedure shipped by the pack → nothing to inject (cf. phase_inject.ts:89).
      if (ctx.packProcedure === undefined) return ok({ text: '' });
      const st = await readFsmStateRaw(ctx.sessionId, 'coding-flow'); // RAW state; selector maps phase internally
      const rubrics = {
        scope: await readRubricContent('scope', 'coding-flow'),
        author: await readRubricContent('author', 'coding-flow'),
      };
      const { text } = selectPhaseBundle(st ?? 'idle', ctx.packProcedure, rubrics);
      return ok({ text });
    },
  });
}

/**
 * phase_inject (GI.4) — channel (a) of the coding-flow per-gate injection: the SINGLE turn-boundary
 * injector. MERGES the two retired injectors (`procedure_pre_inject` + `rubric_pre_inject`) into one — on
 * `prompt_submit`/`session_start` it emits the CURRENT phase's bundle (`selectPhaseBundle`: §0 flow-picker +
 * the matched §1|§2|§3 + §On-a-BLOCK protocol + the phase's audit rubric) EVERY turn (refresh — survives
 * compaction; orientation — §0 reaches the agent before its first tool), and writes the phase to
 * `last-injected-phase-coding-flow` so channel (b) (GI.5, the PreToolUse mid-turn catch) can dedup.
 *
 * Like the legacy injectors, it fires ONLY while the flow is ENGAGED (in a track) — NOT at idle/
 * phases_complete. A WORK cold-start is still oriented: `enter-scoping` arms idle→`scoping` BEFORE this
 * rule runs (file order), so `phase_inject` sees `scoping` and injects SCOPE; a non-work prompt stays idle
 * → no coding-flow noise. (The integration test caught that an unconditional idle-inject sprays SCOPE on
 * every prompt.) Coding-flow-specific (reads coding-flow's FSM + rubrics) — the generic-cartridge form is
 * the tracked follow-up (wg-b7a87452152b parts 5–6).
 *
 * Spec: loop/docs/tasks/T-coding-flow-gate-push-injection.md §GI.4.
 */
import { z } from 'zod';

import { atomicWriteFile } from '../runtime/atomic_write.js';
import { readFsmStateRaw } from '../runtime/fsm_state.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import { buildInjectContext } from './inject_context.js';
import { readRubricContent } from './read_rubric.js';
import type { FunctionRegistry } from './registry.js';
import { selectPhaseBundle } from './select_phase_bundle.js';

/** The per-session dedup key the two channels share (channel a writes it each turn; channel b reads it). */
export const PHASE_KEY = 'last-injected-phase-coding-flow';

/** Inject ONLY while the flow is ENGAGED (the agent is in a track). idle/phases_complete = between tracks:
 *  a WORK prompt is armed to `scoping` by `enter-scoping` BEFORE this rule runs (so a work cold-start IS
 *  oriented via `scoping`), while a non-work prompt stays idle → no coding-flow noise. */
const ENGAGED = new Set([
  'scoping',
  'researching',
  'researched',
  'spec_authored',
  'spec_complete',
  'tasks_loaded',
  'phases_in_flight',
]);

const EmptyArgs = z.object({}).strict();

export function registerPhaseInject(registry: FunctionRegistry): void {
  registry.register({
    name: 'phase_inject',
    argSchema: EmptyArgs,
    durable: false,
    memoizable: false, // re-read each turn so the injection refreshes + reflects a phase change
    costEstimateMs: 3,
    execute: async (_args, ctx) => {
      // Channel (a) — turn boundary only. (Channel (b) / `tool_call` mid-turn catch lands in GI.5.)
      if (ctx.event.kind !== 'prompt_submit' && ctx.event.kind !== 'session_start') return ok(null);
      if (ctx.packProcedure === undefined) return ok(null);
      const st = await readFsmStateRaw(ctx.sessionId, 'coding-flow'); // null on unstarted
      if (st === null || !ENGAGED.has(st)) return ok(null); // not in a track → no inject (no non-work noise)
      const rubrics = {
        scope: await readRubricContent('scope'),
        author: await readRubricContent('author'),
      };
      const { phase, text } = selectPhaseBundle(st, ctx.packProcedure, rubrics);
      if (text.length === 0) return ok(null);
      await atomicWriteFile(sessionStateFile(ctx.sessionId, PHASE_KEY), JSON.stringify({ phase }));
      return ok(buildInjectContext(text));
    },
  });
}

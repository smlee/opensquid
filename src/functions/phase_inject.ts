/**
 * phase_inject (GI.4 + GI.5) — the coding-flow per-gate injection, BOTH delivery channels in one
 * primitive (the merge of the two retired injectors `procedure_pre_inject` + `rubric_pre_inject`). Emits
 * the CURRENT phase's bundle (`selectPhaseBundle`: §0 flow-picker + the matched §1|§2|§3 + §On-a-BLOCK
 * protocol + the phase's audit rubric) and writes the phase to `last-injected-phase-coding-flow`.
 *
 *   - Channel (a) — `prompt_submit`/`session_start` (wired in `entry-and-handoffs`): refresh EVERY turn
 *     (survives compaction; orientation — §0 reaches the agent before its first tool).
 *   - Channel (b) — `tool_call` (wired in `scope-lifecycle`, which already triggers on tool_call): the
 *     INSTANT mid-turn catch. Fires ONLY when the phase changed since the last inject (dedup vs the shared
 *     key) — an in-track tool call that crossed a gate boundary re-orients before the next action; same-
 *     phase tool calls stay silent (and skip the rubric reads — cheap on the per-tool-call hot path). The
 *     PreToolUse bin surfaces the result as a non-blocking `permissionDecision:"defer"` + `additionalContext`
 *     envelope (`hook_output.buildPreToolUseContext`; dispatch.ts surfaces inject_context on tool_call).
 *
 * Both channels fire ONLY while the flow is ENGAGED (in a track) — NOT at idle/phases_complete. A WORK
 * cold-start is still oriented: `enter-scoping` arms idle→`scoping` BEFORE channel (a) runs (file order),
 * so `phase_inject` sees `scoping` and injects SCOPE; a non-work prompt stays idle → no coding-flow noise.
 * (The integration test caught that an unconditional idle-inject sprays SCOPE on every prompt.) Coding-
 * flow-specific (reads coding-flow's FSM + rubrics) — the generic-cartridge form is the tracked follow-up
 * (wg-b7a87452152b parts 5–6).
 *
 * Spec: loop/docs/tasks/T-coding-flow-gate-push-injection.md §GI.4–GI.5.
 */
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { atomicWriteFile } from '../runtime/atomic_write.js';
import { readFsmStateRaw } from '../runtime/fsm_state.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';

import { buildInjectContext } from './inject_context.js';
import { readRubricContent } from './read_rubric.js';
import type { FunctionRegistry } from './registry.js';
import { phaseForState, selectPhaseBundle } from './select_phase_bundle.js';

/** The per-session dedup key the two channels share (channel a writes it each turn; channel b reads it). */
export const PHASE_KEY = 'last-injected-phase-coding-flow';

/** Read the phase last injected this session (written by either channel), or null if none yet. Same
 *  `sessionStateFile` KV the FSM uses; channel (b) reads it to dedup a tool_call against the last inject. */
async function readPhaseKey(sessionId: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(
      await readFile(sessionStateFile(sessionId, PHASE_KEY), 'utf8'),
    ) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'phase' in parsed) {
      const p: unknown = parsed.phase;
      if (typeof p === 'string') return p;
    }
  } catch {
    /* absent / parse error → null */
  }
  return null;
}

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
      // Two channels, both phase-selected + ENGAGED-gated. Channel (a): prompt_submit/session_start —
      // refresh the CURRENT phase's bundle every turn (survives compaction; orients before the first
      // tool). Channel (b): tool_call — the mid-turn catch, fires ONLY when the phase changed since the
      // last inject (an in-track tool call that crossed a gate boundary re-orients before the next action).
      const kind = ctx.event.kind;
      if (kind !== 'prompt_submit' && kind !== 'session_start' && kind !== 'tool_call')
        return ok(null);
      if (ctx.packProcedure === undefined) return ok(null);
      const st = await readFsmStateRaw(ctx.sessionId, 'coding-flow'); // null on unstarted
      if (st === null || !ENGAGED.has(st)) return ok(null); // not in a track → no inject (no non-work noise)
      // Channel (b) dedup — cheap (state read only): same phase as the last inject → stay silent, skipping
      // the procedure-split + rubric reads on the per-tool-call hot path. Channel (a) always refreshes.
      if (kind === 'tool_call' && phaseForState(st) === (await readPhaseKey(ctx.sessionId))) {
        return ok(null);
      }
      const rubrics = {
        scope: await readRubricContent('scope', 'coding-flow'),
        author: await readRubricContent('author', 'coding-flow'),
      };
      const { phase, text } = selectPhaseBundle(st, ctx.packProcedure, rubrics);
      if (text.length === 0) return ok(null);
      await atomicWriteFile(sessionStateFile(ctx.sessionId, PHASE_KEY), JSON.stringify({ phase }));
      return ok(buildInjectContext(text));
    },
  });
}

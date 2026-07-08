/**
 * `set_loop_phase` MCP tool (LSF.2) — the agent-facing emit for the wg-keyed phase store.
 *
 * THE generic core primitive the fullstack-flow PACK's per-stage procedures call at their own real phase
 * boundaries (universal across every stage — CODE's 7 phases included). Core carries NO stage vocabulary: it
 * writes whatever OPAQUE phase LABEL the pack passes, keyed by the canonical `wg-` id, and the reader
 * (`collectLoopState`) shows it only while the item is still at the stage it was emitted under. This is the
 * SEPARATE-from-`log_phase` surface the live status feed reads (subprocess-harness-push.md §2a): `log_phase`
 * stays session-keyed for the commit gate and emits no stage vocabulary.
 *
 * wg-id resolution mirrors `log_phase`'s active-task resolution: an explicit `wg_id` arg wins; else the driven
 * item from `OPENSQUID_ITEM_ID` (a headless lap sets it); else the session's bound checkpoint id. A phase emit
 * with no resolvable item is a loud error (there is nothing to key the phase to).
 *
 * Imports from: zod, ../../runtime/loop/loop_phase_store.js, ../../runtime/hooks/session_id.js,
 *   ../../runtime/loop/checkpoint_key.js.
 * Imported by: mcp/server.ts (handler map).
 */
import { z } from 'zod';

import { setLoopPhase } from '../../runtime/loop/loop_phase_store.js';
import { resolveMcpSessionId } from '../../runtime/hooks/session_id.js';
import { resolveCheckpointKey } from '../../runtime/loop/checkpoint_key.js';

export const SetLoopPhaseSchema = z.object({
  phase: z
    .string()
    .min(1)
    .describe('The phase label WITHIN the current stage (opaque; pack-defined).'),
  index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('This phase’s 1-based position (e.g. 4 of 7).'),
  total: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Total phases in the current stage (e.g. 7).'),
  wg_id: z
    .string()
    .min(1)
    .optional()
    .describe('The canonical wg id (defaults to OPENSQUID_ITEM_ID / the session’s active item).'),
});

export type SetLoopPhaseArgs = z.infer<typeof SetLoopPhaseSchema>;

export interface SetLoopPhaseOutput {
  ok: true;
  wg_id: string;
  phase: string;
  index: number | null;
  total: number | null;
}

async function resolveWgId(explicit: string | undefined): Promise<string | null> {
  if (explicit !== undefined && explicit !== '') return explicit;
  const envItem = process.env.OPENSQUID_ITEM_ID;
  if (envItem !== undefined && envItem !== '') return envItem;
  const sessionId = await resolveMcpSessionId();
  if (sessionId === null) return null;
  return resolveCheckpointKey(sessionId);
}

export async function handleSetLoopPhase(args: SetLoopPhaseArgs): Promise<SetLoopPhaseOutput> {
  const wgId = await resolveWgId(args.wg_id);
  if (wgId === null) {
    throw new Error(
      'set_loop_phase: no item to key the phase to — pass wg_id, or set OPENSQUID_ITEM_ID, or bind an active task.',
    );
  }
  const index = args.index ?? null;
  const total = args.total ?? null;
  await setLoopPhase(wgId, args.phase, index, total);
  return { ok: true, wg_id: wgId, phase: args.phase, index, total };
}

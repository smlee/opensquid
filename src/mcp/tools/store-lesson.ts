/**
 * `store_lesson` MCP tool — wedge-gate Stage 1 input (capture).
 *
 * G.3 architectural exception (T.1.H read-only invariant): Stage 1
 * capture IS THE INPUT to the rule pipeline, not a bypass of it. Stage 2
 * (promotion) is automation-only and NOT exposed via MCP — promoting
 * from an external client would bypass the outcome-validation moat.
 *
 * The `next_steps` field is anti-misuse copy reminding callers NOT to
 * call promote_lesson directly from the harness.
 *
 * Engine `LessonCreateParams` carries `description / body / evidence` —
 * the MCP-surface fields `classification` and `source_signal` are
 * round-tripped via the `evidence` array (prefixed entries) so the
 * data survives without requiring an engine schema bump.
 *
 * Imports from: ../../engine/client.js, ../../engine/types.js, zod.
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import type { EngineClient } from '../../engine/client.js';
import type { LessonCreateParams, LessonCreateResult } from '../../engine/types.js';

export const StoreLessonSchema = z.object({
  description: z.string().min(1).max(280),
  content: z.string().min(1),
  classification: z
    .enum(['workflow', 'preference', 'skill_upgrade'])
    .describe('Three lesson types per context-clearing-cycle'),
  source_session_id: z.string().optional(),
  source_signal: z
    .string()
    .optional()
    .describe('What triggered capture — e.g., "user_correction", "agent_self_audit"'),
});

export type StoreLessonArgs = z.infer<typeof StoreLessonSchema>;

export interface StoreLessonOutput {
  id: string;
  status: 'pending' | 'promoted';
  next_steps: string;
}

export const NEXT_STEPS_GUIDANCE =
  'User validates classification (Stage 1 wedge gate). Promotion (Stage 2) ' +
  'requires sustained outcome signals; do not call promote_lesson directly ' +
  'from the harness — automation handles it.';

export async function handleStoreLesson(
  args: StoreLessonArgs,
  engine: EngineClient,
): Promise<StoreLessonOutput> {
  const evidence: string[] = [`classification:${args.classification}`];
  if (args.source_signal) evidence.push(`source_signal:${args.source_signal}`);
  if (args.source_session_id) evidence.push(`source_session_id:${args.source_session_id}`);

  const params: LessonCreateParams = {
    description: args.description,
    body: args.content,
    evidence,
  };
  const result: LessonCreateResult = await engine.lessonCreate(params);
  return {
    id: result.id,
    status: result.status,
    next_steps: NEXT_STEPS_GUIDANCE,
  };
}

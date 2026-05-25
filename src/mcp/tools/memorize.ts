/**
 * `memorize` MCP tool — direct write-through to `engine.memoryCreate`.
 *
 * G.3 architectural exception (T.1.H read-only invariant): user-explicit
 * memories are SEPARATE from agent-discovered patterns. The wedge gate
 * protects agent learning, not user-explicit policy. `authored_by: 'user'`
 * (default) marks the row eviction-immune so subsequent rule-pipeline
 * activity cannot auto-evict it (see `feedback_user_authored_lessons_immune`).
 *
 * No agent-loop logic here — opensquid just persists what the harness sends.
 * Engine types are imported directly so any RPC param shape change fails
 * typecheck in this file (drift detection per G.3 risk callout).
 *
 * Imports from: ../../engine/client.js, ../../engine/types.js, zod.
 * Imported by: mcp/server.ts (handler map).
 */

import { z } from 'zod';

import type { EngineClient } from '../../engine/client.js';
import type { CreateMemoryResult, MemoryOrigin, MemoryScope } from '../../engine/types.js';

export const MemorizeSchema = z.object({
  description: z
    .string()
    .min(1)
    .max(280)
    .describe('One-sentence summary, used for ranking on recall'),
  content: z.string().min(1).describe('Full memory body (markdown OK)'),
  scope: z.enum(['user', 'project', 'team', 'global']).default('user'),
  authored_by: z
    .string()
    .default('user')
    .describe('Author identity; "user" marks as eviction-immune'),
  origin_label: z
    .enum(['explicit', 'auto', 'imported'])
    .default('explicit')
    .describe('Provenance hint; persisted in the MemoryOrigin block'),
});

export type MemorizeArgs = z.infer<typeof MemorizeSchema>;

export interface MemorizeOutput {
  id: string;
  authored_by: string;
  scope: 'user' | 'project' | 'team' | 'global';
  created_at: string;
}

/**
 * Map the flat user-facing scope enum to the engine's `MemoryScope` shape.
 * Engine resolves per-scope identifiers (project/team name) from the active
 * LOOP_HOME / session context when we hand it a bare object form.
 */
function toEngineScope(scope: MemorizeArgs['scope']): MemoryScope {
  if (scope === 'user' || scope === 'global') return scope;
  return scope === 'project' ? { project: '' } : { team: '' };
}

export async function handleMemorize(
  args: MemorizeArgs,
  engine: EngineClient,
): Promise<MemorizeOutput> {
  const origin: MemoryOrigin = { host: `opensquid-mcp:${args.origin_label}` };
  const result: CreateMemoryResult = await engine.memoryCreate({
    description: args.description,
    content: args.content,
    authored_by: args.authored_by,
    scope: toEngineScope(args.scope),
    origin,
  });
  return {
    id: result.id,
    authored_by: args.authored_by,
    scope: args.scope,
    created_at: result.created_at,
  };
}

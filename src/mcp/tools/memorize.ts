/**
 * `memorize` MCP tool — direct write-through to `engine.memoryCreate`.
 *
 * T-CTX-LOOP CTX.0 (2026-05-29) — VERIFY-PROBE GATE:
 *
 *   Every long-term memory write passes through ONE gate: the agent MUST
 *   present a candidate to the user, the user MUST confirm verbatim, and
 *   the agent MUST pass that verbatim confirmation as `confirmed_quote`.
 *   This is the architectural primitive that prevents unverified
 *   understanding from becoming durable — per
 *   [[project-opensquid-communication-thesis]] (verification = the point
 *   where projecting + understanding meet) +
 *   [[project-memory-architecture-dual-surface-sync]] (long-term records
 *   VERIFIED understanding only; consolidating unverified understanding
 *   makes a misunderstanding durable = the worst drift class).
 *
 *   Two new required fields:
 *     - `verified: literal(true)` — must be the literal value `true`;
 *       any other value (false, undefined) trips Zod rejection with the
 *       schema's describe() string surfaced as the remedy.
 *     - `confirmed_quote: string.min(1)` — the user's verbatim reply
 *       confirming the save. Appended to the persisted content body as
 *       a verification trailer so the accountability quote rides forward
 *       in the long-term store + is visible on recall.
 *
 *   Bypass surfaces (deliberately out of CTX.0 scope): direct CLI
 *   `engine.memoryCreate` calls in setup/cli/memory.ts and
 *   setup/migrate/auto_memory_importer.ts — those are user-initiated
 *   bulk paths that don't go through the agent-side verify cycle.
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

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { Lesson, RagBackend } from '../../rag/types.js';

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
  // T-CTX-LOOP CTX.0 — verify-probe gate. Required.
  verified: z
    .literal(true)
    .describe(
      'T-CTX-LOOP CTX.0 verify-probe gate. MUST be the literal `true`. ' +
        'Agent flow: (1) propose candidate; (2) present in chat with "save this?"; ' +
        '(3) user replies verbatim; (4) pass user reply as `confirmed_quote`; ' +
        '(5) call memorize with `verified: true`. Absent/false rejects.',
    ),
  confirmed_quote: z
    .string()
    .min(1)
    .describe(
      "Verbatim user confirmation quote — the user's own words approving " +
        'the save. Appended to the persisted memory body as a verification ' +
        'trailer so accountability survives into the long-term RAG store.',
    ),
});

export type MemorizeArgs = z.infer<typeof MemorizeSchema>;

export interface MemorizeOutput {
  id: string;
  authored_by: string;
  scope: 'user' | 'project' | 'team' | 'global';
  created_at: string;
}

/**
 * Map the verified memorize args to a `Lesson` for the configured backend (retire-Rust write-path
 * cutover). The memory now lives as a `Lesson`: `scope`/`origin_label` ride as FTS-discoverable
 * tags (recall is tag/content-based); `authored_by` collapses to `Lesson.author` (`'user'` ⇒
 * eviction-immune). The id is a deterministic content-hash so re-memorizing the same body is
 * idempotent (mirrors the migration). The verify-probe trailer rides in the persisted content.
 */
function lessonFromMemorize(args: MemorizeArgs): Lesson {
  // The id identifies the MEMORY BODY (`args.content`), NOT the write event — so
  // re-memorizing the same body is idempotent (the backend upserts by id). Hash
  // the pre-trailer body: the verify-trailer embeds a wall-clock timestamp
  // (withVerificationTrailer), so hashing the trailered content would make the id
  // vary every call — defeating idempotency. The trailer still rides in the
  // stored `content` for accountability; it just doesn't drive identity.
  const id = `mem-${createHash('sha256').update(args.content).digest('hex').slice(0, 16)}`;
  const content = withVerificationTrailer(args.content, args.confirmed_quote);
  return {
    id,
    content,
    tags: [`scope:${args.scope}`, `origin:${args.origin_label}`],
    source: 'memory',
    author: args.authored_by === 'user' ? 'user' : 'agent',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Append the verify-probe accountability trailer to the persisted content.
 * Per CTX.0 the user's verbatim confirmation rides with the memory body
 * into the long-term store so the verification provenance is recoverable
 * on recall — not just at write-time.
 */
function withVerificationTrailer(content: string, confirmedQuote: string): string {
  const trailer =
    '\n\n---\n' +
    `_T-CTX-LOOP CTX.0 verified ${new Date().toISOString()} via verbatim user confirmation:_ ` +
    `"${confirmedQuote}"`;
  return content + trailer;
}

export async function handleMemorize(
  args: MemorizeArgs,
  backend: RagBackend,
): Promise<MemorizeOutput> {
  const lesson = lessonFromMemorize(args);
  await backend.storeLesson(lesson);
  return {
    id: lesson.id,
    authored_by: args.authored_by,
    scope: args.scope,
    created_at: lesson.createdAt,
  };
}

/**
 * agent_bridge built-in tool — `store_lesson`.
 *
 * Authoritative spec: the warm-agent planning notes [not retained — see docs/tasks/WAB.1-architecture.md, which is] WAB.6 §"Tool
 * surface" + memory `project_opensquid_wedge_gate_two_stages` Stage 1 +
 * `project_opensquid_automation_buffer_pattern`.
 *
 * Why the automation buffer (not direct wedge-gate `capturePendingLesson`):
 *   The existing `src/runtime/wedge/capture.ts` writes to
 *   `~/.opensquid/sessions/<sessionId>/pending-lessons/potential-lessons/`
 *   — the buffer is SESSION-scoped, keyed by an opensquid hook session id
 *   (provided by the host's hook payload). The chat-bridge does NOT have a
 *   matching session id at this layer — the daemon-side SessionKey is a
 *   `(platform, chatId, threadId?)` tuple, not the opensquid hook session.
 *   Cross-wiring those would force a session-id translation table that
 *   doesn't exist yet (and would belong in WAB.7 daemon wiring, not in a
 *   tool wrapper).
 *
 *   So we follow the spec's recommendation: write to a separate
 *   automation-buffer file at `~/.opensquid/agent-bridge/captured-lessons.jsonl`
 *   (one JSON-per-line, append-only). End-of-run / user-driven validation
 *   walks this file in a later pass — the wedge-gate Stage 1 invariant
 *   holds because nothing here promotes silently; the user MUST review
 *   the JSONL before anything moves to the proper wedge-gate buffer.
 *
 * Failure mode:
 *   - Disk full / permission denied → the underlying `appendFile` throws,
 *     and the agent loop catches + feeds the error back to the model as a
 *     `tool_result`. The model can decide to retry or give up.
 *
 * Imports from: node:fs/promises, node:path, node:os, zod, ../types.js.
 * Imported by: ./index.ts (tools barrel).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { ToolContext, ToolHandler, ToolSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Lesson-type enum — narrower than the runtime `LessonType` enum because
// the chat agent currently surfaces only the three Stage-1-eligible flavors.
// `schedule_outcome` is excluded — that flavor only lives on the scheduler
// path and a chat-agent capture of it would be miscategorized.
// ---------------------------------------------------------------------------

const StoreLessonInput = z.object({
  content: z.string().min(1),
  type: z.enum(['workflow', 'preference', 'skill_upgrade']),
  /** Optional tags. Echoed straight to the JSONL row. */
  tags: z.array(z.string()).default([]),
  /**
   * Caller's confidence (0..1). Defaults to 0.5 — middle-of-the-road — so
   * the buffer-walk UI can sort capture rows by claimed confidence without
   * the model having to invent a number for low-stakes captures.
   */
  confidence: z.number().min(0).max(1).default(0.5),
});
type StoreLessonInputT = z.infer<typeof StoreLessonInput>;

export const storeLessonSpec: ToolSpec = {
  name: 'store_lesson',
  description:
    'Capture a lesson candidate (workflow / preference / skill_upgrade) into the agent-bridge buffer for user-validated Stage-1 wedge-gate review.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Lesson body (Markdown OK).' },
      type: {
        type: 'string',
        enum: ['workflow', 'preference', 'skill_upgrade'],
        description: 'Which of the three Stage-1 lesson categories this candidate fits.',
      },
      tags: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['content', 'type'],
    additionalProperties: false,
  },
  validate: (input) => StoreLessonInput.parse(input),
};

// ---------------------------------------------------------------------------
// Buffer path — `~/.opensquid/agent-bridge/captured-lessons.jsonl`.
// OPENSQUID_HOME-aware so tests can isolate to mkdtemp.
// ---------------------------------------------------------------------------

export function bufferPath(): string {
  const root = process.env.OPENSQUID_HOME ?? join(homedir(), '.opensquid');
  return join(root, 'agent-bridge', 'captured-lessons.jsonl');
}

// ---------------------------------------------------------------------------
// Handler factory — accepts an optional clock seam for tests so the
// emitted `capturedAt` timestamp is deterministic in fixtures.
// ---------------------------------------------------------------------------

export interface MakeStoreLessonHandlerOptions {
  nowIso?: () => string;
}

export function makeStoreLessonHandler(opts: MakeStoreLessonHandlerOptions = {}): ToolHandler {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  return async (input, ctx: ToolContext) => {
    const parsed = input as StoreLessonInputT;
    const row = {
      capturedAt: nowIso(),
      sessionKey: ctx.sessionKey,
      projectUuid: ctx.projectUuid,
      type: parsed.type,
      content: parsed.content,
      tags: parsed.tags,
      confidence: parsed.confidence,
    };
    const path = bufferPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(row) + '\n', 'utf8');
    return `captured ${parsed.type} lesson for Stage-1 review (buffered, awaiting user validation)`;
  };
}

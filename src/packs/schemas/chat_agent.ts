/**
 * Zod schema for `chat_agent.yaml` — the pack's chat-agent binding side-file.
 *
 * Authoritative source: `docs/tasks/T-warm-agent-chat-bridge.md` §WAB.6
 * "Key code shapes". This file is the schema slice (WAB.6 prep); the loader
 * delta + runtime binding land in WAB.6 proper.
 *
 * Position in the pack format: parallel side-file to `models.yaml`,
 * `channels.yaml`, `notifications.yaml`, `drift_response.yaml`. A pack that
 * does NOT ship `chat_agent.yaml` falls back to built-in defaults in the
 * runtime (`pack_binding.ts`, WAB.6) — the schema layer doesn't materialize
 * those defaults because "no file" is the bind-time signal, not "empty
 * document" (which IS a valid declaration the author meant to write).
 *
 * Field semantics (one per field; defaults applied at parse time):
 *   - `default_model` — REQUIRED alias name from the pack's `models.yaml`.
 *     Schema accepts any non-empty string; alias-existence validation runs
 *     at resolve time in WAB.6's `pack_binding.ts` (the alias resolver is
 *     the right layer — it can cross-reference the loaded `ModelsConfig`).
 *     Schema deliberately does NOT enumerate model names (matches the
 *     `project_opensquid_model_neutral_subagent_primitive` lock: the schema
 *     stays model-neutral; concrete model names appear ONLY in
 *     `models.yaml`).
 *   - `system_prompt` — optional file path relative to pack root. Loader
 *     resolves + reads at session creation. Empty / absent → built-in
 *     terse prompt (defined in WAB.6 runtime, not here).
 *   - `skills` — opt-in skills beyond the three built-ins. Names match
 *     skill IDs declared in the pack's `skills/`. Empty by default.
 *   - `disable_builtins` — subset of the three built-ins to remove from
 *     the chat agent's tool surface. Enum is sealed at the three names
 *     `chat_send | recall | store_lesson` per WAB.1 decision (e) — adding
 *     a future built-in is a deliberate schema change.
 *   - `max_tool_iterations` — caps the agent-loop iteration count
 *     (WAB.4 dispatcher tunable). Bounded 1..32; default 8.
 *   - `max_tokens` — per-turn token cap forwarded to Anthropic
 *     `messages.create`. Bounded 64..8192; default 1024.
 *
 * `.strict()` is mandatory — a typo like `defualt_model:` or `skllls:` must
 * fail loudly at load. Same posture as every other pack-config schema.
 *
 * The bounds on `max_tool_iterations` (32) and `max_tokens` (8192) are
 * pragmatic safety rails, not API limits. The Anthropic API supports higher
 * `max_tokens`; we cap at the chat-bridge use case (terse replies) so a
 * misconfigured pack can't accidentally bill thousands of tokens per turn.
 * A future use case that needs a higher cap is a deliberate schema change
 * (memory `project_opensquid_runtime_failure_handling` favors validate-early
 * over silent-fail-open).
 *
 * Imports from: zod only (self-contained per audit constraint).
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// BuiltinToolName — the three default tools every chat agent gets unless the
// pack opts out via `disable_builtins`. Enum is sealed; a typo / future-name
// in `disable_builtins` fails enum validation at load (no silent fall-through
// to a never-disabled built-in).
//
// These three names mirror the runtime tools registered by `pack_binding.ts`
// in WAB.6:
//   - `chat_send`    — reply to the user via the active chat channel
//   - `recall`       — fetch project-scoped memories from the RAG backend
//   - `store_lesson` — buffer a candidate lesson for end-of-run validation
// ---------------------------------------------------------------------------

export const BuiltinToolName = z.enum(['chat_send', 'recall', 'store_lesson']);
export type BuiltinToolName = z.infer<typeof BuiltinToolName>;

// ---------------------------------------------------------------------------
// ChatAgentSchema — the document shape.
//
// `default_model` is the only required field. Everything else has a documented
// default so a minimum-viable `chat_agent.yaml` is two lines:
//   default_model: fast_chat
//
// Cross-field validation (e.g. "is `default_model` actually a declared alias
// in this pack's `models.yaml`?") is deferred to the resolver in WAB.6's
// `pack_binding.ts` — schemas validate documents in isolation per the
// established side-file pattern (see `models.ts` head comment).
// ---------------------------------------------------------------------------

export const ChatAgentSchema = z
  .object({
    default_model: z.string().min(1),
    system_prompt: z.string().optional(),
    skills: z.array(z.string()).default([]),
    disable_builtins: z.array(BuiltinToolName).default([]),
    max_tool_iterations: z.number().int().min(1).max(32).default(8),
    max_tokens: z.number().int().min(64).max(8192).default(1024),
  })
  .strict();
export type ChatAgentConfig = z.infer<typeof ChatAgentSchema>;

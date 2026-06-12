/**
 * agent_bridge — shared types (WAB.2, 0.5.94).
 *
 * Authoritative source: `docs/tasks/WAB.1-architecture.md` decisions (b) +
 * (c), and the warm-agent planning notes (not retained — docs/tasks/WAB.1-architecture.md is the surviving authority) WAB.2 spec.
 *
 * Why one types module: all six WAB sub-modules (event_bus, transport_bridge,
 * session_manager, agent_loop, batch, dispatcher) share the SessionKey +
 * InboundChatEvent + OutboundChatReply contracts. Inlining them per-module
 * would either duplicate the zod schemas (drift risk) or chain imports
 * deeply (re-export thrash). One types module + barrel re-export keeps
 * the public surface flat for consumers.
 *
 * Schema validation discipline: every type that crosses an external
 * boundary (chokidar-watched JSONL file, MCP tool args, future RPC) has a
 * zod schema declared next to its TS interface; the schema is the runtime
 * gate and the TS type is `z.infer<typeof schema>`. This matches the
 * pattern in `src/runtime/types.ts`.
 *
 * Imports from: zod.
 * Imported by: event_bus.ts, transport_bridge.ts, (future) session_manager,
 *   agent_loop, batch, dispatcher.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// SessionKey — `(platform, chatId, threadId?)` triple.
//
// Mirrors Hermes `build_session_key` (`gateway/platforms/base.py:2762`) and
// the inbox row's `thread_id` field (written by the chat daemon).
// Telegram supergroup ids are negative integers; DM user ids are positive;
// both stringify safely. Discord + Slack reserved for future adapters.
// ---------------------------------------------------------------------------

export const SessionPlatform = z.enum(['telegram', 'discord', 'slack']);
export type SessionPlatform = z.infer<typeof SessionPlatform>;

export const sessionKeySchema = z.object({
  platform: SessionPlatform,
  chatId: z.string().min(1),
  threadId: z.string().optional(),
});
export type SessionKey = z.infer<typeof sessionKeySchema>;

/**
 * Canonical slug form. `<platform>:<chatId>[:<threadId>]`.
 *
 * Used as the LRU cache key (WAB.3) and as the on-disk filename base for
 * persisted session history. Hex-encoded by the persistence layer before
 * touching the filesystem; this function is the pre-encoding form.
 */
export function sessionKeyString(k: SessionKey): string {
  return k.threadId !== undefined
    ? `${k.platform}:${k.chatId}:${k.threadId}`
    : `${k.platform}:${k.chatId}`;
}

// ---------------------------------------------------------------------------
// InboundChatEvent — emitted by transport_bridge when a JSONL row lands.
//
// Field mapping from the inbox row (snake_case, written by the chat
// daemon's inbox append) → modern camelCase. The mapping happens at the
// bridge boundary so the rest
// of the warm-agent code sees a clean Phase-1 shape.
//
// `projectUuid` is carried explicitly because the transport_bridge is
// per-project (one instance per `~/.opensquid/projects/<uuid>/inbox/`),
// and the downstream session manager + agent loop need it for tool calls
// that resolve back to project-scoped resources (RAG scope, channel
// routing, etc.).
//
// `raw` preserves the original JSONL payload for callers that want
// platform-specific fields (mentions_bot, etc.) without expanding the
// typed surface.
// ---------------------------------------------------------------------------

export const inboundChatEventSchema = z.object({
  kind: z.literal('inbound_message'),
  sessionKey: sessionKeySchema,
  messageId: z.string().min(1),
  sender: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
  }),
  text: z.string(),
  receivedAt: z.string().datetime({ offset: true }),
  enqueuedAt: z.string().datetime({ offset: true }),
  projectUuid: z.string().uuid(),
  /**
   * Owning umbrella id (T-CHAT-AS-TERMINAL CAT.5). Stamped by a
   * umbrella-keyed transport bridge (one umbrella ↔ one chat session,
   * invariants #2/#4). The dispatcher's T-DEL arbitration reads
   * `umbrellaLiveSessionLease(umbrellaId)` to decide whether to answer. A
   * project-keyed transport (legacy / general session) omits it, in which case
   * the dispatcher falls back to the project lease (`liveSessionLease`).
   */
  umbrellaId: z.string().min(1).optional(),
  raw: z.record(z.unknown()).optional(),
});
export type InboundChatEvent = z.infer<typeof inboundChatEventSchema>;

// ---------------------------------------------------------------------------
// OutboundChatReply — agent's reply payload before it hits the legacy RPC.
//
// Used by future WAB.6 chat_send tool wrapper. Declared here to keep the
// agent_bridge public surface in one place; transport_bridge does not emit
// these (outbound goes via RPC, not file-watcher).
// ---------------------------------------------------------------------------

export const outboundChatReplySchema = z.object({
  sessionKey: sessionKeySchema,
  text: z.string().min(1),
  /** Optional source message id to thread under (Telegram reply_to_message_id). */
  replyTo: z.string().optional(),
  projectUuid: z.string().uuid(),
});
export type OutboundChatReply = z.infer<typeof outboundChatReplySchema>;

// ---------------------------------------------------------------------------
// ChatHistoryEntry — Anthropic-message-compatible turn fragment.
//
// Added WAB.3, 0.5.95. The agent loop (WAB.4) maps these directly into the
// `messages` array of `Anthropic.messages.create`; the persistence layer
// (WAB.3) round-trips them via JSONL. Keeping the shape Anthropic-native
// avoids per-turn translation in the hot path.
//
// Content is an array of discriminated content blocks: text (plain prose),
// tool_use (assistant invokes a tool — id + name + input), tool_result
// (synthesized user message carrying tool output back to the model). This
// mirrors Anthropic's documented message-content shape; see
// https://docs.claude.com/en/api/messages content-block reference.
//
// `cacheMark` is an OPTIONAL transient hint set by the agent loop at
// request-construction time; it is NOT persisted (cache breakpoints are
// recomputed every turn from history positions per WAB.1 (c) — "marker
// policy is system + last 2 user messages"). The field lives on the type
// so the schema accepts persisted rows that might carry it from older
// builds, but `appendEntries` strips it before writing.
//
// Validation: discriminated-union zod schema (`role` is the discriminator).
// Strict on the content-block kinds so a typo in a producer surfaces at
// the boundary, not deep inside `messages.create`.
// ---------------------------------------------------------------------------

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.string(),
});

export const chatHistoryContentBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
]);
export type ChatHistoryContentBlock = z.infer<typeof chatHistoryContentBlockSchema>;

export const chatHistoryEntrySchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(chatHistoryContentBlockSchema),
  timestamp: z.string().datetime({ offset: true }),
  cacheMark: z.boolean().optional(),
});
export type ChatHistoryEntry = z.infer<typeof chatHistoryEntrySchema>;

// ---------------------------------------------------------------------------
// SessionState — warm-pool per-session container (WAB.3).
//
// WAB.1 decision (c) LOCKS the following:
//   - NO Anthropic SDK client field — one daemon-wide client is shared.
//   - `modelAlias` is the RESOLVED model id string (alias→id resolution
//     happens at session creation in WAB.6; the state carries the final
//     string the SDK consumes).
//   - `packId` (NOT `packId`) per pack-rename lock.
//   - `turnInFlight` guards reentrant batches; the batch coordinator
//     (WAB.5) reads + writes it under a per-session mutex.
//
// `lastActivityMs` is the wall-clock at last `getOrCreate` / `appendTurn`.
// The LRU's own `updateAgeOnGet: true` setting handles TTL extension on
// touch; this field is kept additionally so consumers (telemetry, future
// admin CLI) can introspect activity without poking lru-cache internals.
// ---------------------------------------------------------------------------

export interface SessionState {
  key: SessionKey;
  history: ChatHistoryEntry[];
  lastActivityMs: number;
  projectUuid: string;
  packId: string;
  modelAlias: string;
  /** Set true while an agent turn is mid-flight; batches buffer until cleared. */
  turnInFlight: boolean;
}

// ---------------------------------------------------------------------------
// Tool surface — WAB.4 (0.5.97).
//
// `ToolSpec` is the agent-side contract: the JSON Schema (`input_schema`)
// is what gets serialized into `Anthropic.messages.create({ tools })`,
// and `validate?` is the runtime guard the dispatcher runs BEFORE the
// handler sees the input.
//
// Why split JSON Schema from runtime validator:
//   - Anthropic's API requires `input_schema` as JSON Schema; the model
//     uses it to constrain tool_use blocks.
//   - We don't trust the model to honor the schema — tool inputs cross a
//     trust boundary into opensquid runtime. Runtime validation is
//     independent.
//   - Keeping `validate` optional + caller-provided lets tools use zod
//     (`schema.parse`), ajv (`ajv.compile(...)` adapted), or a hand-rolled
//     guard — no new runtime dependency forced.
//
// `ToolHandler` is invoked with the VALIDATED input. Context carries
// per-session identifiers the handler needs for project-scoped resource
// access (RAG scope, channel routing) — see WAB.6 tool implementations.
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for tool input. Serialized to Anthropic as-is. */
  input_schema: Record<string, unknown>;
  /**
   * Optional runtime input guard. Called by the dispatcher BEFORE the
   * handler. Implementations: `(input) => schema.parse(input)` for zod,
   * or any function that throws on invalid input. Return value is
   * forwarded to the handler (so tools can both validate AND narrow types
   * in one step).
   */
  validate?: (input: unknown) => unknown;
}

export interface ToolContext {
  sessionKey: SessionKey;
  projectUuid: string;
}

export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<string>;

export interface ToolDispatcher {
  /** Snapshot of registered tool specs — passed to Anthropic.messages.create. */
  list(): ToolSpec[];
  /**
   * Dispatch a single tool_use block from the model. Throws on unknown
   * name (caller should treat as a hard error — the model invoked
   * something not in `list()`) or on validation failure. The returned
   * string is fed back to the model as `tool_result.content`.
   */
  call(name: string, input: unknown, ctx: ToolContext): Promise<string>;
}

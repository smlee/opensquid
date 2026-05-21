/**
 * agent_bridge — warm-pool chat-agent shell.
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` +
 * `docs/tasks/WAB.1-architecture.md`. Currently shipped slices:
 *   - WAB.2 (0.5.94): types, typed event bus, transport bridge.
 *   - WAB.3 (0.5.95): SessionManager + SessionPersistence + history types.
 *   - WAB.4 (0.5.97): runAgentTurn + SimpleToolDispatcher (skipped
 *     0.5.96 — burned in a parallel WIZ.2 slice that WAB.3 reset over).
 *   - WAB.5 (0.5.99): BatchCoordinator + ChatDispatcher (adaptive
 *     batching window + per-session mutex/queue glue).
 *   - WAB.6 (0.5.100): pack_binding + 3 built-in tools (chat_send,
 *     recall, store_lesson) + chat_agent.yaml pack side-file load.
 * WAB.7+ will add daemon + CLI.
 *
 * Re-exports are flat (no nested namespaces) so consumers can write
 * `import { InboxTransportBridge, AgentEventBus, ... } from '<root>/runtime'`.
 *
 * Imports from: ./types.js, ./event_bus.js, ./transport_bridge.js,
 *   ./session_manager.js, ./session_persistence.js, ./agent_loop.js,
 *   ./tool_dispatcher.js, ./batch.js, ./dispatcher.js.
 * Imported by: src/runtime/index.ts (barrel).
 */

export {
  SessionPlatform,
  sessionKeySchema,
  type SessionKey,
  sessionKeyString,
  inboundChatEventSchema,
  type InboundChatEvent,
  outboundChatReplySchema,
  type OutboundChatReply,
  chatHistoryContentBlockSchema,
  type ChatHistoryContentBlock,
  chatHistoryEntrySchema,
  type ChatHistoryEntry,
  type SessionState,
  type ToolSpec,
  type ToolContext,
  type ToolHandler,
  type ToolDispatcher,
} from './types.js';
export { type AgentBridgeEvents, AgentEventBus } from './event_bus.js';
export { InboxTransportBridge, type TransportBridgeOptions } from './transport_bridge.js';
export {
  SessionPersistence,
  type SessionPersistenceOptions,
  encodeSessionSlug,
} from './session_persistence.js';
export {
  AGENT_CACHE_MAX_SIZE,
  AGENT_CACHE_IDLE_TTL_MS,
  type EvictionReason,
  SessionManager,
  type SessionManagerOptions,
} from './session_manager.js';
export { SimpleToolDispatcher, type ToolRegistration } from './tool_dispatcher.js';
export {
  DEFAULT_SUBSCRIPTION_TIMEOUT_MS,
  SUBSCRIPTION_HISTORY_SNIPPET_LEN,
  buildPromptBody,
  defaultClaudeCliClient,
  runAgentTurnSubscription,
  type ClaudeCliClient,
  type ClaudeCliRunRequest,
  type RunAgentTurnSubscriptionOptions,
  type RunAgentTurnSubscriptionResult,
} from './agent_loop_subscription.js';
export {
  MAX_TOOL_ITERATIONS,
  DEFAULT_MAX_TOKENS,
  CACHE_BREAKPOINT_USER_MSGS,
  runAgentTurn,
  type RunAgentTurnOptions,
  type RunAgentTurnResult,
  type AnthropicCacheControl,
  type AnthropicTextBlockParam,
  type AnthropicToolUseBlockParam,
  type AnthropicToolResultBlockParam,
  type AnthropicContentBlockParam,
  type AnthropicMessageParam,
  type AnthropicSystemBlock,
  type AnthropicResponseTextBlock,
  type AnthropicResponseToolUseBlock,
  type AnthropicResponseBlock,
  type AnthropicMessageResponse,
  type AnthropicMessageCreateParams,
  type AnthropicMessageClient,
} from './agent_loop.js';
export {
  BatchCoordinator,
  type BatchCoordinatorOptions,
  TG_SPLIT_THRESHOLD,
  TEXT_BATCH_FAST_LEN,
  TEXT_BATCH_SHORT_LEN,
  TEXT_BATCH_FAST_DELAY_MS,
  TEXT_BATCH_SHORT_DELAY_MS,
  TEXT_BATCH_DELAY_MS_DEFAULT,
  TEXT_BATCH_SPLIT_DELAY_MS,
} from './batch.js';
export {
  ChatDispatcher,
  type ChatDispatcherOptions,
  type DispatcherAgentLoopOptions,
} from './dispatcher.js';
export {
  buildChatToolDispatcher,
  type BuildChatToolDispatcherOptions,
  type BuildChatToolDispatcherResult,
} from './pack_binding.js';
export {
  BUILT_INS,
  chatSendSpec,
  defaultDaemonSend,
  makeChatSendHandler,
  makeRecallHandler,
  makeStoreLessonHandler,
  recallSpec,
  storeLessonBufferPath,
  storeLessonSpec,
  type DaemonSendFn,
  type DaemonSendParams,
  type MakeStoreLessonHandlerOptions,
} from './tools/index.js';

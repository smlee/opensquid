/**
 * agent_bridge — warm-pool chat-agent shell.
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` +
 * `docs/tasks/WAB.1-architecture.md`. Currently shipped slices:
 *   - WAB.2 (0.5.94): types, typed event bus, transport bridge.
 *   - WAB.3 (0.5.95): SessionManager + SessionPersistence + history types.
 * WAB.4+ will add AgentLoop, BatchCoordinator, pack_binding, daemon, CLI.
 *
 * Re-exports are flat (no nested namespaces) so consumers can write
 * `import { InboxTransportBridge, AgentEventBus, ... } from '<root>/runtime'`.
 *
 * Imports from: ./types.js, ./event_bus.js, ./transport_bridge.js,
 *   ./session_manager.js, ./session_persistence.js.
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

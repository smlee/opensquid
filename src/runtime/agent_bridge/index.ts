/**
 * agent_bridge — warm-pool chat-agent shell (WAB.2, 0.5.94).
 *
 * Authoritative spec: `docs/tasks/T-warm-agent-chat-bridge.md` +
 * `docs/tasks/WAB.1-architecture.md`. Public surface stays minimal — only
 * the types, the typed event bus, and the transport bridge land in WAB.2.
 * WAB.3+ will add SessionManager, AgentLoop, BatchCoordinator,
 * pack_binding, daemon, and CLI.
 *
 * Re-exports are flat (no nested namespaces) so consumers can write
 * `import { InboxTransportBridge, AgentEventBus, ... } from '<root>/runtime'`.
 *
 * Imports from: ./types.js, ./event_bus.js, ./transport_bridge.js.
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
} from './types.js';
export { type AgentBridgeEvents, AgentEventBus } from './event_bus.js';
export { InboxTransportBridge, type TransportBridgeOptions } from './transport_bridge.js';

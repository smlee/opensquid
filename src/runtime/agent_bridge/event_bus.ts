/**
 * agent_bridge — typed in-process event bus (WAB.2, 0.5.94).
 *
 * Authoritative source: `docs/tasks/WAB.1-architecture.md` decision (a) —
 * in-process `EventEmitter` wrapper for v1; UDS deferred indefinitely.
 * The chat-daemon already owns the inter-process boundary (its RPC
 * server at `src/channels/daemon/rpc_server.ts`); the warm-agent
 * needs only an INTRA-process bus to wire transport_bridge →
 * batch_coordinator → session_manager → agent_loop.
 *
 * Why a typed wrapper, not raw EventEmitter:
 *   - The base `events.EventEmitter` types listeners as `(...args: any[])`.
 *     Forcing the event-map shape at the type layer eliminates a
 *     whole class of "I emitted but the listener never fired" bugs that
 *     come from typos in event names or mismatched payload shapes.
 *   - The `emit` overload returns `boolean` (whether any listener fired);
 *     we preserve that contract so callers can react to "nobody listening
 *     yet" (e.g. drop the event vs buffer it).
 *
 * Listener error policy (per WAB.1 (a) risk callout):
 *   EventEmitter is synchronous-emit; if a listener throws, the rest of
 *   the listener chain still runs (since Node 14). Async listener
 *   rejections do NOT propagate to the emitter — callers MUST wrap their
 *   own async work in try/catch and surface failures via their own
 *   audit/log sink. This bus does NOT install a global error handler
 *   because every listener has different failure semantics (transport
 *   parse error vs agent-loop timeout vs ack ordering).
 *
 * Imports from: node:events, ./types.js.
 * Imported by: transport_bridge.ts, (future) batch.ts, dispatcher.ts.
 */

import { EventEmitter } from 'node:events';

import type { InboundChatEvent } from './types.js';

// ---------------------------------------------------------------------------
// Event map — typed contract between emitter and listener.
//
// Adding a new event = adding a new property here + updating callers.
// The TS compiler enforces both sides — no string-literal drift.
// ---------------------------------------------------------------------------

export interface AgentBridgeEvents {
  /** Emitted by `InboxTransportBridge` for each validated JSONL row. */
  inbound: (event: InboundChatEvent) => void;
}

// ---------------------------------------------------------------------------
// AgentEventBus — typed EventEmitter facade.
//
// Subclassing `EventEmitter` (rather than composing) is intentional:
//   - Inheriting the well-tested `removeAllListeners` / `listenerCount` /
//     etc. surface without re-implementing or proxying every method.
//   - The `on` / `off` / `emit` overrides narrow the inherited signatures
//     to the typed event map; consumers see only `K extends keyof AgentBridgeEvents`.
// ---------------------------------------------------------------------------

export class AgentEventBus extends EventEmitter {
  on<K extends keyof AgentBridgeEvents>(event: K, listener: AgentBridgeEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof AgentBridgeEvents>(event: K, listener: AgentBridgeEvents[K]): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof AgentBridgeEvents>(event: K, listener: AgentBridgeEvents[K]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof AgentBridgeEvents>(
    event: K,
    ...args: Parameters<AgentBridgeEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

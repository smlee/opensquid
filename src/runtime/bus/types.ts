/**
 * Bus envelope + message kinds (T-fsm-actor-runtime §BUS.1).
 *
 * The typed envelope that replaces the single-event `EventEmitter`
 * (`agent_bridge/event_bus.ts`). 10 external-observation kinds (the existing
 * EventKind set) + 5 internal-coordination kinds.
 */
export type ActorAddr = string;
export type CorrelationId = string;

export type MessageKind =
  // external observations (the existing 10 EventKinds)
  | 'tool_call'
  | 'post_tool_call'
  | 'prompt_submit'
  | 'session_start'
  | 'session_end'
  | 'stop'
  | 'schedule'
  | 'webhook'
  | 'inbound_channel'
  | 'file_changed'
  // internal coordination (new)
  | 'transition'
  | 'gate_action'
  | 'memory_tick'
  | 'topology'
  | 'lap';

/** Topic-routed delivery target: a `topic:<name>` string (vs. a direct ActorAddr). */
export type Topic = `topic:${string}`;

export interface Envelope<P = unknown> {
  seq: number; // monotonic Lamport order (bus-owned)
  from: ActorAddr;
  // An ActorAddr or a Topic — both are strings; routing distinguishes by the `topic:` prefix
  // (matches gstack's string-based routing). Typed as `string` to avoid a redundant union
  // (ActorAddr already subsumes the `topic:` template literal).
  to: string;
  kind: MessageKind;
  corr?: CorrelationId;
  payload: P;
  ts: number;
}

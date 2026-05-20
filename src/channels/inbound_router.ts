/**
 * `InboundRouter` — AUTO.6 inbound-channel dispatcher.
 *
 * Authoritative source: `docs/tasks/automation.md` AUTO.6. Walks the user's
 * `RoutingConfig.channelMapping`, finds the adapter for each concrete URI,
 * and (when the adapter implements `subscribeInbound`) attaches a per-
 * abstract-channel listener. Inbound messages flow:
 *
 *   adapter.subscribeInbound(handler)
 *     → handler(event)
 *       → CapabilityGate.check(pack, 'send_message', sender)   [optional]
 *         → if allowed → dispatch(event)
 *         → if denied  → audit + drop
 *
 * Sender allowlist is intentionally enforced via the existing AUTO.3
 * capability gate (`send_message` capability with `channels:` allowlist
 * — repurposed for inbound: a sender ID is the principal, mapped against
 * the same pack-declared list). The router does NOT introduce a new gate
 * surface; reuse keeps audit + override semantics identical.
 *
 * Engine-vocabulary: emits `InboundChannelEvent` only; never knows what
 * downstream evaluator does with the event.
 *
 * Imports from: ../runtime/event.js, ../runtime/capability_gate.js,
 * ./types.js. Imported by: src/runtime/daemon.ts (later) + tests.
 */

import type { InboundChannelEvent } from '../runtime/event.js';
import type { CapabilityGate } from '../runtime/capability_gate.js';

import type { ChannelAdapter, InboundSubscription, RoutingConfig } from './types.js';

/**
 * Per-abstract-channel inbound binding. Each binding maps one abstract
 * channel name (e.g. `'alerts'`) to the pack that listens on it. Multiple
 * packs can listen on the same abstract channel — declare one binding per
 * (pack, channel) pair.
 */
export interface InboundBinding {
  /** Pack id — passed to `CapabilityGate.check` as the principal. */
  pack: string;
  /** Abstract channel name — looked up in `routing.channelMapping`. */
  channel: string;
}

export type InboundDispatcher = (event: InboundChannelEvent) => Promise<void>;

interface AuditCommon {
  pack: string;
  channel: string;
}
export type InboundRouterAuditEntry =
  | (AuditCommon & { event: 'inbound_subscribed'; uri: string; scheme: string })
  | (AuditCommon & { event: 'inbound_unmapped' })
  | (AuditCommon & { event: 'inbound_no_adapter'; scheme: string })
  | (AuditCommon & { event: 'inbound_adapter_not_inboundable'; uri: string; scheme: string })
  | (AuditCommon & { event: 'inbound_dispatched'; uri: string; sender: string })
  | (AuditCommon & { event: 'inbound_sender_denied'; sender: string; reason: string })
  | (AuditCommon & { event: 'inbound_dispatch_error'; sender: string; reason: string });

export type InboundRouterAuditSink = (entry: InboundRouterAuditEntry) => void;

export interface InboundRouterOpts {
  /** Optional capability gate. When set, every inbound event runs through
   *  `gate.check({pack, capability: 'send_message', target: sender})`
   *  BEFORE dispatch. Denial drops the event + audits. Unset → no
   *  sender filtering (dev/test default). */
  capabilityGate?: CapabilityGate;
  auditLog?: InboundRouterAuditSink;
}

const noopAudit: InboundRouterAuditSink = () => {
  /* default audit sink */
};

/**
 * Tracks active subscriptions so `stop()` can unsubscribe in reverse-bind
 * order. Each entry carries enough context to audit a clean teardown if
 * unsubscribe ever fails.
 */
interface ActiveSubscription {
  pack: string;
  channel: string;
  sub: InboundSubscription;
}

export class InboundRouter {
  private readonly subscriptions: ActiveSubscription[] = [];
  private readonly auditLog: InboundRouterAuditSink;
  private readonly capabilityGate: CapabilityGate | undefined;
  private state: 'idle' | 'running' | 'stopped' = 'idle';

  constructor(opts: InboundRouterOpts = {}) {
    this.auditLog = opts.auditLog ?? noopAudit;
    this.capabilityGate = opts.capabilityGate;
  }

  /**
   * Walk `bindings`, resolve each abstract channel → URI via
   * `routing.channelMapping`, look up the adapter by URI scheme, and call
   * its `subscribeInbound` to attach a sender-gated dispatcher. Skips +
   * audits any binding whose channel is unmapped, whose adapter scheme
   * isn't registered, or whose adapter doesn't implement `subscribeInbound`.
   *
   * Idempotent: a second `start()` while already running throws so the
   * caller surfaces a lifecycle bug rather than double-subscribing.
   */
  async start(
    bindings: readonly InboundBinding[],
    routing: RoutingConfig,
    adapters: Map<string, ChannelAdapter>,
    dispatch: InboundDispatcher,
  ): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`InboundRouter.start: invalid state "${this.state}"`);
    }
    this.state = 'running';

    for (const binding of bindings) {
      const uri = routing.channelMapping[binding.channel];
      if (uri === undefined || uri === '') {
        this.auditLog({
          event: 'inbound_unmapped',
          pack: binding.pack,
          channel: binding.channel,
        });
        continue;
      }
      const schemePart = uri.split('://')[0];
      if (schemePart === undefined || schemePart === '') {
        this.auditLog({
          event: 'inbound_unmapped',
          pack: binding.pack,
          channel: binding.channel,
        });
        continue;
      }
      const adapter = adapters.get(schemePart);
      if (adapter === undefined) {
        this.auditLog({
          event: 'inbound_no_adapter',
          pack: binding.pack,
          channel: binding.channel,
          scheme: schemePart,
        });
        continue;
      }
      if (adapter.subscribeInbound === undefined) {
        this.auditLog({
          event: 'inbound_adapter_not_inboundable',
          pack: binding.pack,
          channel: binding.channel,
          uri,
          scheme: schemePart,
        });
        continue;
      }

      // Closure captures `binding` so the gate + audit + dispatch path
      // can reference the right pack/channel without threading them
      // through `subscribeInbound`'s handler signature.
      const handler = async (event: InboundChannelEvent): Promise<void> => {
        await this.handleInbound(binding, event, dispatch);
      };

      const sub = await adapter.subscribeInbound(handler);
      this.subscriptions.push({ pack: binding.pack, channel: binding.channel, sub });
      this.auditLog({
        event: 'inbound_subscribed',
        pack: binding.pack,
        channel: binding.channel,
        uri,
        scheme: schemePart,
      });
    }
  }

  /**
   * Unsubscribe every active binding in reverse order. Idempotent — a
   * second stop() is a no-op. Each unsubscribe is best-effort; failures
   * are swallowed so a single bad adapter doesn't strand the rest.
   */
  async stop(): Promise<void> {
    if (this.state !== 'running') {
      this.state = 'stopped';
      return;
    }
    this.state = 'stopped';
    while (this.subscriptions.length > 0) {
      const entry = this.subscriptions.pop();
      if (entry === undefined) break;
      try {
        await entry.sub.unsubscribe();
      } catch {
        // best-effort — audit-and-continue, never throw out of stop().
      }
    }
  }

  /** Test/inspection — number of active subscriptions. */
  activeSubscriptionCount(): number {
    return this.subscriptions.length;
  }

  // -------------------------------------------------------------------------
  // Internals.

  private async handleInbound(
    binding: InboundBinding,
    event: InboundChannelEvent,
    dispatch: InboundDispatcher,
  ): Promise<void> {
    // Sender allowlist via capability gate. Repurposes `send_message`'s
    // `channels:` allowlist as the sender principal set — the gate's
    // glob-list matcher handles user-id allowlists cleanly.
    if (this.capabilityGate !== undefined) {
      const verdict = await this.capabilityGate.check({
        pack: binding.pack,
        capability: 'send_message',
        target: event.sender,
        context: { inbound: true, channelUri: event.channelUri },
      });
      if (!verdict.allowed) {
        this.auditLog({
          event: 'inbound_sender_denied',
          pack: binding.pack,
          channel: binding.channel,
          sender: event.sender,
          reason: verdict.message ?? verdict.source,
        });
        return;
      }
    }
    try {
      await dispatch(event);
      this.auditLog({
        event: 'inbound_dispatched',
        pack: binding.pack,
        channel: binding.channel,
        uri: event.channelUri,
        sender: event.sender,
      });
    } catch (err) {
      this.auditLog({
        event: 'inbound_dispatch_error',
        pack: binding.pack,
        channel: binding.channel,
        sender: event.sender,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

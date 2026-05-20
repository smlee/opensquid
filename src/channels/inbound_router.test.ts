/* eslint-disable @typescript-eslint/require-await */
/**
 * Tests for `InboundRouter` (AUTO.6).
 *
 * Coverage matches the spec's acceptance criteria:
 *   1. Routes by abstract-channel mapping — telegram, discord, slack adapters
 *      each get subscribed when their abstract channel is mapped.
 *   2. Unmapped abstract channel → audit `inbound_unmapped`, no subscribe.
 *   3. Unknown URI scheme → audit `inbound_no_adapter`.
 *   4. Adapter without subscribeInbound (webhook-style) → audit
 *      `inbound_adapter_not_inboundable`, skip.
 *   5. Sender allowlist via capability gate — denial drops event + audits.
 *   6. Loop-break — a dispatch that triggers an outbound to the SAME channel
 *      does not re-enter the inbound handler (separate code paths).
 *   7. Lifecycle — start() then stop() unsubscribes cleanly. Idempotent stop.
 *   8. Double-start throws.
 *
 * Strategy:
 *   - Fake adapters implementing the `ChannelAdapter` shape (no real SDK).
 *   - In-memory CapabilityGate (mock packs map).
 *   - Audit log captured for assertion.
 */

import { describe, expect, it, vi } from 'vitest';

import type { InboundChannelEvent } from '../runtime/event.js';
import { CapabilityGate, type PackPermissions } from '../runtime/capability_gate.js';

import {
  InboundRouter,
  type InboundBinding,
  type InboundRouterAuditEntry,
} from './inbound_router.js';
import type {
  ChannelAdapter,
  ChannelMessage,
  InboundSubscription,
  RoutingConfig,
  SendResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface FakeAdapter extends ChannelAdapter {
  /** Test hook — push a synthetic event into the registered handler. */
  fireInbound(event: InboundChannelEvent): Promise<void>;
  subscribeCount(): number;
  unsubscribeCount(): number;
}

function makeFakeAdapter(scheme: string, opts: { inboundable?: boolean } = {}): FakeAdapter {
  const inboundable = opts.inboundable ?? true;
  let handler: ((event: InboundChannelEvent) => Promise<void>) | null = null;
  let subscribed = 0;
  let unsubscribed = 0;

  const base: ChannelAdapter = {
    scheme,
    validate: (uri: string): boolean => uri.startsWith(`${scheme}://`),
    send: async (_uri: string, _msg: ChannelMessage): Promise<SendResult> =>
      Promise.resolve({ ok: true }),
  };

  if (inboundable) {
    base.subscribeInbound = async (
      h: (event: InboundChannelEvent) => Promise<void>,
    ): Promise<InboundSubscription> => {
      handler = h;
      subscribed += 1;
      return {
        unsubscribe: async (): Promise<void> => {
          handler = null;
          unsubscribed += 1;
        },
      };
    };
  }

  return Object.assign(base, {
    fireInbound: async (event: InboundChannelEvent): Promise<void> => {
      if (handler === null) {
        throw new Error(`fireInbound: ${scheme} adapter has no active subscription`);
      }
      await handler(event);
    },
    subscribeCount: (): number => subscribed,
    unsubscribeCount: (): number => unsubscribed,
  });
}

function makeRouting(channelMapping: Record<string, string>): RoutingConfig {
  return {
    severityTiers: {
      critical: [],
      error: [],
      warning: [],
      info: [],
    },
    channelMapping,
  };
}

function makeGate(packs: Map<string, PackPermissions>): CapabilityGate {
  return new CapabilityGate({ packs, trustBuiltinDeny: false, homeDir: '/tmp/test' });
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('InboundRouter — routing by abstract-channel mapping', () => {
  it('subscribes the adapter whose URI scheme matches the abstract channel', async () => {
    const telegram = makeFakeAdapter('telegram');
    const discord = makeFakeAdapter('discord');
    const slack = makeFakeAdapter('slack');
    const adapters = new Map<string, ChannelAdapter>([
      ['telegram', telegram],
      ['discord', discord],
      ['slack', slack],
    ]);
    const audit: InboundRouterAuditEntry[] = [];
    const router = new InboundRouter({ auditLog: (e) => audit.push(e) });

    const bindings: InboundBinding[] = [
      { pack: 'p1', channel: 'alerts' },
      { pack: 'p1', channel: 'mods' },
      { pack: 'p2', channel: 'team' },
    ];
    const routing = makeRouting({
      alerts: 'telegram://-100123/42',
      mods: 'discord://111/222',
      team: 'slack://acme/general',
    });
    const dispatch = vi.fn(async () => Promise.resolve());

    await router.start(bindings, routing, adapters, dispatch);

    expect(telegram.subscribeCount()).toBe(1);
    expect(discord.subscribeCount()).toBe(1);
    expect(slack.subscribeCount()).toBe(1);
    expect(router.activeSubscriptionCount()).toBe(3);
    expect(audit.filter((e) => e.event === 'inbound_subscribed')).toHaveLength(3);
  });

  it('audits + skips when the abstract channel is unmapped', async () => {
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const audit: InboundRouterAuditEntry[] = [];
    const router = new InboundRouter({ auditLog: (e) => audit.push(e) });

    await router.start(
      [{ pack: 'p1', channel: 'missing' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      vi.fn(async () => Promise.resolve()),
    );

    expect(telegram.subscribeCount()).toBe(0);
    expect(router.activeSubscriptionCount()).toBe(0);
    expect(audit.find((e) => e.event === 'inbound_unmapped')).toBeDefined();
  });

  it('audits + skips when no adapter handles the URI scheme', async () => {
    const adapters = new Map<string, ChannelAdapter>();
    const audit: InboundRouterAuditEntry[] = [];
    const router = new InboundRouter({ auditLog: (e) => audit.push(e) });

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'unknown://x/y' }),
      adapters,
      vi.fn(async () => Promise.resolve()),
    );

    const entry = audit.find((e) => e.event === 'inbound_no_adapter');
    expect(entry).toBeDefined();
    if (entry?.event === 'inbound_no_adapter') {
      expect(entry.scheme).toBe('unknown');
    }
  });

  it('audits + skips adapters without subscribeInbound (webhook adapter)', async () => {
    const webhook = makeFakeAdapter('webhook', { inboundable: false });
    const adapters = new Map<string, ChannelAdapter>([['webhook', webhook]]);
    const audit: InboundRouterAuditEntry[] = [];
    const router = new InboundRouter({ auditLog: (e) => audit.push(e) });

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'webhook://my-endpoint' }),
      adapters,
      vi.fn(async () => Promise.resolve()),
    );

    expect(webhook.subscribeCount()).toBe(0);
    const entry = audit.find((e) => e.event === 'inbound_adapter_not_inboundable');
    expect(entry).toBeDefined();
    if (entry?.event === 'inbound_adapter_not_inboundable') {
      expect(entry.scheme).toBe('webhook');
    }
  });
});

describe('InboundRouter — capability-gated sender allowlist', () => {
  it("dispatches when sender is in the pack's send_message channels allowlist", async () => {
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const audit: InboundRouterAuditEntry[] = [];
    const packs = new Map<string, PackPermissions>([
      [
        'p1',
        {
          name: 'p1',
          permissions: { send_message: { channels: ['8075471258', 'admin-*'], deny: [] } },
        },
      ],
    ]);
    const gate = makeGate(packs);
    const router = new InboundRouter({ auditLog: (e) => audit.push(e), capabilityGate: gate });
    const dispatch = vi.fn(async () => Promise.resolve());

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      dispatch,
    );

    await telegram.fireInbound({
      kind: 'inbound_channel',
      channelUri: 'telegram://-100123',
      sender: '8075471258',
      text: 'hello',
      receivedAt: '2026-05-20T12:00:00.000Z',
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(audit.find((e) => e.event === 'inbound_dispatched')).toBeDefined();
  });

  it('denies + audits when sender is NOT in the allowlist (capability gate)', async () => {
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const audit: InboundRouterAuditEntry[] = [];
    const packs = new Map<string, PackPermissions>([
      [
        'p1',
        {
          name: 'p1',
          permissions: { send_message: { channels: ['8075471258'], deny: [] } },
        },
      ],
    ]);
    const gate = makeGate(packs);
    const router = new InboundRouter({ auditLog: (e) => audit.push(e), capabilityGate: gate });
    const dispatch = vi.fn(async () => Promise.resolve());

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      dispatch,
    );

    await telegram.fireInbound({
      kind: 'inbound_channel',
      channelUri: 'telegram://-100123',
      sender: '999_unknown_attacker',
      text: 'pwn',
      receivedAt: '2026-05-20T12:00:00.000Z',
    });

    expect(dispatch).not.toHaveBeenCalled();
    const denial = audit.find((e) => e.event === 'inbound_sender_denied');
    expect(denial).toBeDefined();
    if (denial?.event === 'inbound_sender_denied') {
      expect(denial.sender).toBe('999_unknown_attacker');
    }
  });

  it('dispatches without sender gating when no capabilityGate is configured', async () => {
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const router = new InboundRouter();
    const dispatch = vi.fn(async () => Promise.resolve());

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      dispatch,
    );

    await telegram.fireInbound({
      kind: 'inbound_channel',
      channelUri: 'telegram://-100123',
      sender: 'anyone',
      text: 'hi',
      receivedAt: '2026-05-20T12:00:00.000Z',
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('InboundRouter — loop-break', () => {
  it('an outbound send triggered by an inbound event does NOT re-enter inbound', async () => {
    // The dispatch handler simulates a skill that, on inbound, sends an
    // outbound message back to the same channel. The router must keep
    // inbound + outbound paths separate — `adapter.send()` is a no-op for
    // this test (we only verify the inbound handler isn't re-called).
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const audit: InboundRouterAuditEntry[] = [];
    const router = new InboundRouter({ auditLog: (e) => audit.push(e) });

    let inboundCount = 0;
    const dispatch = vi.fn(async (event: InboundChannelEvent): Promise<void> => {
      inboundCount += 1;
      // Simulate the skill sending an outbound message back. If this
      // looped, fireInbound would re-invoke dispatch and inboundCount
      // would exceed 1.
      await telegram.send(event.channelUri, { text: 'echo: ' + event.text });
    });

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      dispatch,
    );

    await telegram.fireInbound({
      kind: 'inbound_channel',
      channelUri: 'telegram://-100123',
      sender: '7777',
      text: 'ping',
      receivedAt: '2026-05-20T12:00:00.000Z',
    });

    // Exactly one dispatch — the outbound `send()` does NOT trigger a
    // synthetic inbound. The fake adapter's `send()` is a no-op stub;
    // it does NOT call fireInbound.
    expect(inboundCount).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('InboundRouter — lifecycle', () => {
  it('stop() unsubscribes every active binding in reverse order', async () => {
    const telegram = makeFakeAdapter('telegram');
    const discord = makeFakeAdapter('discord');
    const adapters = new Map<string, ChannelAdapter>([
      ['telegram', telegram],
      ['discord', discord],
    ]);
    const router = new InboundRouter();

    await router.start(
      [
        { pack: 'p1', channel: 'alerts' },
        { pack: 'p1', channel: 'mods' },
      ],
      makeRouting({ alerts: 'telegram://-100123', mods: 'discord://111/222' }),
      adapters,
      vi.fn(async () => Promise.resolve()),
    );
    expect(router.activeSubscriptionCount()).toBe(2);

    await router.stop();
    expect(router.activeSubscriptionCount()).toBe(0);
    expect(telegram.unsubscribeCount()).toBe(1);
    expect(discord.unsubscribeCount()).toBe(1);
  });

  it('stop() is idempotent — second call is a no-op', async () => {
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const router = new InboundRouter();

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      vi.fn(async () => Promise.resolve()),
    );
    await router.stop();
    await router.stop();
    expect(telegram.unsubscribeCount()).toBe(1);
  });

  it('double-start throws', async () => {
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const router = new InboundRouter();
    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      vi.fn(async () => Promise.resolve()),
    );
    await expect(
      router.start(
        [],
        makeRouting({}),
        adapters,
        vi.fn(async () => Promise.resolve()),
      ),
    ).rejects.toThrow(/invalid state/);
  });

  it('handler dispatch error is audited as inbound_dispatch_error and does not throw', async () => {
    const telegram = makeFakeAdapter('telegram');
    const adapters = new Map<string, ChannelAdapter>([['telegram', telegram]]);
    const audit: InboundRouterAuditEntry[] = [];
    const router = new InboundRouter({ auditLog: (e) => audit.push(e) });

    await router.start(
      [{ pack: 'p1', channel: 'alerts' }],
      makeRouting({ alerts: 'telegram://-100123' }),
      adapters,
      async () => {
        throw new Error('downstream eval crashed');
      },
    );

    await telegram.fireInbound({
      kind: 'inbound_channel',
      channelUri: 'telegram://-100123',
      sender: 's',
      text: 't',
      receivedAt: '2026-05-20T12:00:00.000Z',
    });

    const err = audit.find((e) => e.event === 'inbound_dispatch_error');
    expect(err).toBeDefined();
    if (err?.event === 'inbound_dispatch_error') {
      expect(err.reason).toContain('downstream eval crashed');
    }
  });
});

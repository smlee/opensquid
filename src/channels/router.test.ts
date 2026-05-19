/**
 * NotificationRouter unit tests — resolution algorithm + multicast
 * partial-success accounting. See router.ts header for the contract.
 */

import { describe, expect, it } from 'vitest';

import { NotificationRouter } from './router.js';
import type { ChannelAdapter, ChannelMessage, RoutingConfig, SendResult } from './types.js';

type Behavior = 'ok' | { error: string } | { throw: string };

function makeMockAdapter(scheme: string, behavior: Behavior): ChannelAdapter {
  return {
    scheme,
    validate: (uri: string): boolean => uri.startsWith(`${scheme}://`),
    send: async (_uri: string, _message: ChannelMessage): Promise<SendResult> => {
      await Promise.resolve();
      if (behavior === 'ok') return { ok: true };
      if ('throw' in behavior) throw new Error(behavior.throw);
      return { ok: false, error: behavior.error };
    },
  };
}

const baseConfig = (): RoutingConfig => ({
  severityTiers: {
    critical: ['alerts', 'audit_log'],
    error: ['alerts'],
    warning: ['chat'],
    info: ['chat'],
  },
  channelMapping: {
    alerts: 'telegram://chat_id/topic_id',
    audit_log: 'discord://webhook',
  },
});

describe('NotificationRouter.resolve', () => {
  it('uses per-project override when present (skips severityTiers)', () => {
    const router = new NotificationRouter();
    router.registerAdapter(makeMockAdapter('chat', 'ok'));
    router.registerAdapter(makeMockAdapter('slack', 'ok'));

    const config: RoutingConfig = {
      ...baseConfig(),
      perProjectOverride: {
        'project-x': {
          critical: ['oncall'],
          error: ['oncall'],
          warning: ['oncall'],
          info: ['oncall'],
        },
      },
      channelMapping: {
        ...baseConfig().channelMapping,
        oncall: 'slack://team/oncall',
      },
    };

    const targets = router.resolve('critical', 'project-x', config);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.uri).toBe('slack://team/oncall');
    expect(targets[0]?.adapter.scheme).toBe('slack');
  });

  it('uses severityTiers when no per-project override applies', () => {
    const router = new NotificationRouter();
    router.registerAdapter(makeMockAdapter('chat', 'ok'));
    router.registerAdapter(makeMockAdapter('telegram', 'ok'));
    router.registerAdapter(makeMockAdapter('discord', 'ok'));

    const targets = router.resolve('critical', null, baseConfig());
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.uri)).toStrictEqual([
      'telegram://chat_id/topic_id',
      'discord://webhook',
    ]);
  });

  it('skips abstract names with no entry in channelMapping (silent skip, no throw)', () => {
    const router = new NotificationRouter();
    router.registerAdapter(makeMockAdapter('chat', 'ok'));
    router.registerAdapter(makeMockAdapter('telegram', 'ok'));

    const config: RoutingConfig = {
      ...baseConfig(),
      severityTiers: {
        ...baseConfig().severityTiers,
        critical: ['alerts', 'missing_name', 'also_missing'],
      },
    };

    const targets = router.resolve('critical', null, config);
    // alerts → telegram resolves; missing_name + also_missing → silently skipped.
    expect(targets).toHaveLength(1);
    expect(targets[0]?.uri).toBe('telegram://chat_id/topic_id');
  });

  it('falls back to chat adapter when severityTiers[severity] is empty', () => {
    const router = new NotificationRouter();
    router.registerAdapter(makeMockAdapter('chat', 'ok'));

    const config: RoutingConfig = {
      ...baseConfig(),
      severityTiers: {
        critical: [],
        error: [],
        warning: [],
        info: [],
      },
    };

    const targets = router.resolve('error', null, config);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.uri).toBe('chat://');
    expect(targets[0]?.adapter.scheme).toBe('chat');
  });

  it('skips URIs whose scheme has no registered adapter', () => {
    const router = new NotificationRouter();
    // chat registered, telegram NOT registered.
    router.registerAdapter(makeMockAdapter('chat', 'ok'));

    const targets = router.resolve('critical', null, baseConfig());
    // Both `alerts`(telegram) + `audit_log`(discord) have URIs but no
    // adapter → both skipped → empty → chat fallback fires.
    expect(targets).toHaveLength(1);
    expect(targets[0]?.uri).toBe('chat://');
  });
});

describe('NotificationRouter.multicast', () => {
  it('partial success: 3 targets, 1 ok / 1 ok:false / 1 throws → sent=1 failed=2', async () => {
    const router = new NotificationRouter();
    router.registerAdapter(makeMockAdapter('chat', 'ok'));
    router.registerAdapter(makeMockAdapter('telegram', { error: 'rate limited' }));
    router.registerAdapter(makeMockAdapter('discord', { throw: 'network down' }));

    const config: RoutingConfig = {
      ...baseConfig(),
      severityTiers: {
        ...baseConfig().severityTiers,
        critical: ['chat', 'alerts', 'audit_log'],
      },
    };

    const result = await router.multicast(
      'critical',
      null,
      { text: 'boom', severity: 'critical' },
      config,
    );

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toContain('rate limited');
    expect(result.errors).toContain('network down');
  });

  it('all channels fail (incl. chat fallback) → sent=0 failed=N, no throw', async () => {
    const router = new NotificationRouter();
    router.registerAdapter(makeMockAdapter('chat', { error: 'stderr closed' }));

    const config: RoutingConfig = {
      severityTiers: { critical: [], error: [], warning: [], info: [] },
      channelMapping: {},
    };

    const result = await router.multicast(
      'critical',
      null,
      { text: 'doomed', severity: 'critical' },
      config,
    );

    // resolve() → [] → chat fallback fires → one failing target.
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toStrictEqual(['stderr closed']);
  });
});

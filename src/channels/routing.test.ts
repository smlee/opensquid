/**
 * CAT.1a — unit tests for the umbrella routing source + pure resolution FSM.
 *
 * Covers:
 *   - ChannelsConfig schema (.strict(), reserved `general` id forbidden)
 *   - loadChannelsConfig: ENOENT/malformed/schema-invalid ⇒ null (fail-quiet)
 *   - resolveInboundUmbrella: DM→general, topic→umbrella (border #3),
 *     bare-group→umbrella, General thread→general (#5), orphan→null
 *   - resolveOutbound: reply-to-source per umbrella / general
 *   - resolveUmbrellaForCwd: longest-prefix match, no-match→null
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChannelsConfig,
  GENERAL_UMBRELLA,
  channelsConfigPath,
  loadChannelsConfig,
  resolveConfiguredChannel,
  resolveInboundUmbrella,
  resolveOutbound,
  resolvePlatformChannel,
  resolveTelegramChannel,
  resolveUmbrellaForCwd,
} from './routing.js';

// A representative two-umbrella + general config (mirrors the real layout:
// loop umbrella = topic 15, raumpilates = topic 281, general owns the DM).
const CFG = ChannelsConfig.parse({
  v: 1,
  umbrellas: [
    {
      id: 'loop',
      members: [
        '/Users/x/projects/loop',
        '/Users/x/projects/loop-engine',
        '/Users/x/projects/opensquid',
      ],
      telegram: { chat_id: '-1003923174632', topic_id: 15 },
    },
    {
      id: 'raumpilates-fe',
      members: ['/Users/x/projects/RaumPilates/RaumPilates-FE'],
      telegram: { chat_id: '-1003923174632', topic_id: 281 },
    },
  ],
  general: {
    telegram: {
      chat_id: '-1003923174632',
      dm_user_ids: ['8075471258'],
      owns_general_thread: true,
    },
  },
});

describe('ChannelsConfig schema', () => {
  it('rejects an umbrella that claims the reserved "general" id', () => {
    const r = ChannelsConfig.safeParse({
      v: 1,
      umbrellas: [{ id: 'general', members: ['/x'], telegram: { chat_id: '-1' } }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown keys (.strict())', () => {
    const r = ChannelsConfig.safeParse({ v: 1, umbrellas: [], bogus: true });
    expect(r.success).toBe(false);
  });

  it('accepts a minimal config (no general, no telegram)', () => {
    const r = ChannelsConfig.safeParse({ v: 1, umbrellas: [{ id: 'u', members: [] }] });
    expect(r.success).toBe(true);
  });
});

describe('resolveInboundUmbrella', () => {
  it('routes a topic message to the umbrella owning that (chat, topic) — border #3', () => {
    expect(
      resolveInboundUmbrella(CFG, {
        platform: 'telegram',
        chatId: '-1003923174632',
        topicId: 15,
        senderId: '111',
        direct: false,
      }),
    ).toBe('loop');
    expect(
      resolveInboundUmbrella(CFG, {
        platform: 'telegram',
        chatId: '-1003923174632',
        topicId: 281,
        senderId: '111',
        direct: false,
      }),
    ).toBe('raumpilates-fe');
  });

  it('routes a DM from an allowlisted sender to general — #5', () => {
    expect(
      resolveInboundUmbrella(CFG, {
        platform: 'telegram',
        chatId: '8075471258',
        senderId: '8075471258',
        direct: true,
      }),
    ).toBe(GENERAL_UMBRELLA);
  });

  it('orphans a DM from a non-allowlisted sender', () => {
    expect(
      resolveInboundUmbrella(CFG, {
        platform: 'telegram',
        chatId: '999',
        senderId: '999',
        direct: true,
      }),
    ).toBeNull();
  });

  it('routes a bare-group (no topic) message to general when it owns the thread', () => {
    expect(
      resolveInboundUmbrella(CFG, {
        platform: 'telegram',
        chatId: '-1003923174632',
        senderId: '111',
        direct: false,
      }),
    ).toBe(GENERAL_UMBRELLA);
  });

  it('orphans an unknown topic in a known chat', () => {
    expect(
      resolveInboundUmbrella(CFG, {
        platform: 'telegram',
        chatId: '-1003923174632',
        topicId: 999,
        senderId: '111',
        direct: false,
      }),
    ).toBeNull();
  });

  it('prefers an umbrella owning the bare-group key over the general thread', () => {
    const cfg = ChannelsConfig.parse({
      v: 1,
      umbrellas: [{ id: 'solo', members: [], telegram: { chat_id: '-50' } }],
      general: { telegram: { chat_id: '-50', owns_general_thread: true } },
    });
    expect(
      resolveInboundUmbrella(cfg, {
        platform: 'telegram',
        chatId: '-50',
        senderId: '1',
        direct: false,
      }),
    ).toBe('solo');
  });
});

describe('resolveOutbound', () => {
  it('returns the umbrella telegram target (reply-to-source)', () => {
    expect(resolveOutbound(CFG, 'loop')).toEqual({ chat_id: '-1003923174632', topic_id: 15 });
  });

  it('returns the general chat (no topic) for general', () => {
    expect(resolveOutbound(CFG, GENERAL_UMBRELLA)).toEqual({ chat_id: '-1003923174632' });
  });

  it('returns null for an unknown umbrella', () => {
    expect(resolveOutbound(CFG, 'nope')).toBeNull();
  });
});

describe('resolveConfiguredChannel / resolvePlatformChannel', () => {
  // Telegram parity: the real channels.json carries no `platform` key, so the
  // configured resolver must default to `telegram:<chat_id>` (+ topic) exactly
  // as the old hardcoded resolveTelegramChannel did.
  it('defaults to telegram:<chat_id>+topic when no platform pointer is set (parity)', () => {
    expect(resolveConfiguredChannel(CFG, 'loop')).toEqual({
      channel: 'telegram:-1003923174632',
      threadId: '15',
    });
  });

  it('resolves general to telegram:<chat_id> with no thread (parity)', () => {
    expect(resolveConfiguredChannel(CFG, GENERAL_UMBRELLA)).toEqual({
      channel: 'telegram:-1003923174632',
    });
  });

  it('returns null for an unknown umbrella (no binding)', () => {
    expect(resolveConfiguredChannel(CFG, 'nope')).toBeNull();
  });

  // Platform-agnostic proof: a config declaring a DIFFERENT configured platform
  // resolves to `<that-platform>:<id>` — the wire prefix follows the pointer,
  // not a telegram literal, even though that platform's sender isn't wired.
  it('follows the configured platform pointer for the wire prefix (not telegram)', () => {
    const cfg = ChannelsConfig.parse({
      v: 1,
      platform: 'discord',
      umbrellas: [{ id: 'loop', members: ['/x'], telegram: { chat_id: '-1003923174632', topic_id: 15 } }],
    });
    expect(resolveConfiguredChannel(cfg, 'loop')).toEqual({
      channel: 'discord:-1003923174632',
      threadId: '15',
    });
  });

  // The explicit-platform formatter is a literal-free primitive both wrappers share.
  it('resolvePlatformChannel builds <platform>:<native_id> from its argument', () => {
    expect(resolvePlatformChannel(CFG, 'loop', 'slack')).toEqual({
      channel: 'slack:-1003923174632',
      threadId: '15',
    });
    expect(resolveTelegramChannel(CFG, 'loop')).toEqual({
      channel: 'telegram:-1003923174632',
      threadId: '15',
    });
  });
});

describe('resolveUmbrellaForCwd', () => {
  it('matches an exact member cwd', () => {
    expect(resolveUmbrellaForCwd(CFG, '/Users/x/projects/opensquid')).toBe('loop');
  });

  it('matches a nested path under a member', () => {
    expect(resolveUmbrellaForCwd(CFG, '/Users/x/projects/loop-engine/crates/core')).toBe('loop');
  });

  it('longest-prefix wins when members nest', () => {
    const cfg = ChannelsConfig.parse({
      v: 1,
      umbrellas: [
        { id: 'outer', members: ['/Users/x/projects'] },
        { id: 'inner', members: ['/Users/x/projects/loop'] },
      ],
    });
    expect(resolveUmbrellaForCwd(cfg, '/Users/x/projects/loop/src')).toBe('inner');
  });

  it('does NOT match a sibling whose name shares a prefix (the /-boundary guard)', () => {
    // `/Users/x/projects/loop-extra` must NOT match member `/Users/x/projects/loop`.
    expect(resolveUmbrellaForCwd(CFG, '/Users/x/projects/loop-extra')).toBeNull();
  });

  it('returns null when no umbrella claims the cwd', () => {
    expect(resolveUmbrellaForCwd(CFG, '/tmp/somewhere-else')).toBeNull();
  });
});

describe('loadChannelsConfig', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cat1a-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it('returns null when the file is absent (ENOENT)', async () => {
    expect(await loadChannelsConfig()).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    await writeFile(channelsConfigPath(), '{ not json', 'utf8');
    expect(await loadChannelsConfig()).toBeNull();
  });

  it('returns null on a schema-invalid file (unknown key)', async () => {
    await writeFile(channelsConfigPath(), JSON.stringify({ v: 1, umbrellas: [], x: 1 }), 'utf8');
    expect(await loadChannelsConfig()).toBeNull();
  });

  it('loads + validates a good config', async () => {
    await writeFile(channelsConfigPath(), JSON.stringify(CFG), 'utf8');
    const loaded = await loadChannelsConfig();
    expect(loaded?.umbrellas.map((u) => u.id)).toEqual(['loop', 'raumpilates-fe']);
  });
});

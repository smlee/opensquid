/**
 * CAT.1b — tests for the transport→umbrella inbox writer.
 *
 * The critical assertion is byte-compatibility: a row written by
 * `routeAndWriteInbound` MUST parse under `src/runtime/chat/inbox.ts InboxRow`
 * (the schema every live reader binds to), and `channel` MUST be the
 * `"<platform>:<chatId>"` shape the legacy daemon wrote.
 */
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InboxRow } from '../runtime/chat/inbox.js';
import { orphanInboxFile, umbrellaInboxFile } from '../runtime/paths.js';

import { ChannelsConfig } from './routing.js';
import { buildInboxLine, routeAndWriteInbound } from './transport_inbox.js';
import type { InboundChatMessage } from './types.js';

const CFG = ChannelsConfig.parse({
  v: 1,
  umbrellas: [
    { id: 'loop', members: ['/x/loop'], telegram: { chat_id: '-1003923174632', topic_id: 15 } },
  ],
  general: {
    telegram: { chat_id: '-1003923174632', dm_user_ids: ['8075471258'], owns_general_thread: true },
  },
});

function tgMsg(over: Partial<InboundChatMessage> = {}): InboundChatMessage {
  return {
    platform: 'telegram',
    messageId: '510',
    chatId: '-1003923174632',
    topicId: 15,
    sender: 'L0g1cProphet',
    senderId: '8075471258',
    text: 'hello',
    receivedAt: '2026-06-02T04:55:11.000Z',
    mentionsBot: false,
    direct: false,
    ...over,
  };
}

describe('buildInboxLine', () => {
  it('produces the byte-compatible row (channel = <platform>:<chatId>)', () => {
    const line = buildInboxLine(tgMsg(), '2026-06-02T04:55:11.295Z');
    expect(line).toEqual({
      v: 1,
      id: '510',
      thread_id: '15',
      platform: 'telegram',
      channel: 'telegram:-1003923174632',
      sender: 'L0g1cProphet',
      sender_id: '8075471258',
      text: 'hello',
      received_at: '2026-06-02T04:55:11.000Z',
      enqueued_at: '2026-06-02T04:55:11.295Z',
      mentions_bot: false,
    });
  });

  it('omits thread_id when the message has no topic', () => {
    const line = buildInboxLine(tgMsg({ topicId: undefined }), 'now');
    expect('thread_id' in line).toBe(false);
  });

  it('the row parses under the live InboxRow schema (byte-compat guarantee)', () => {
    const line = buildInboxLine(tgMsg(), '2026-06-02T04:55:11.295Z');
    expect(InboxRow.safeParse(line).success).toBe(true);
  });
});

describe('routeAndWriteInbound', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cat1b-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it('routes a topic message to the umbrella inbox', async () => {
    const r = await routeAndWriteInbound(CFG, tgMsg(), 'now');
    expect(r).toEqual({
      destination: 'umbrella',
      umbrellaId: 'loop',
      inboxPath: umbrellaInboxFile('loop', 'telegram'),
    });
    const raw = await readFile(umbrellaInboxFile('loop', 'telegram'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(InboxRow.safeParse(JSON.parse(raw.trim())).success).toBe(true);
  });

  it('routes an allowlisted DM to the general inbox', async () => {
    const dm = tgMsg({ chatId: '8075471258', topicId: undefined, direct: true });
    const r = await routeAndWriteInbound(CFG, dm, 'now');
    expect(r.destination).toBe('umbrella');
    expect(r.umbrellaId).toBe('general');
    expect(r.inboxPath).toBe(umbrellaInboxFile('general', 'telegram'));
  });

  it('routes an unknown topic to the orphan inbox', async () => {
    const r = await routeAndWriteInbound(CFG, tgMsg({ topicId: 999 }), 'now');
    expect(r).toEqual({ destination: 'orphan', inboxPath: orphanInboxFile('telegram') });
    const raw = await readFile(orphanInboxFile('telegram'), 'utf8');
    expect(InboxRow.safeParse(JSON.parse(raw.trim())).success).toBe(true);
  });

  it('appends (does not overwrite) across multiple messages', async () => {
    await routeAndWriteInbound(CFG, tgMsg({ messageId: '1' }), 'now');
    await routeAndWriteInbound(CFG, tgMsg({ messageId: '2' }), 'now');
    const raw = await readFile(umbrellaInboxFile('loop', 'telegram'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });
});

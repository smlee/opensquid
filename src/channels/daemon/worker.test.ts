/**
 * Worker inbound-wiring test (CAT.1b).
 *
 * Asserts the load-bearing wiring claim: the worker's `wireInboundTransport`
 * connects an adapter's `subscribeTransport` to `routeAndWriteInbound`, which
 * writes a byte-compatible umbrella inbox row. Driven with a FAKE adapter +
 * injected channels config + an `mkdtemp` OPENSQUID_HOME — no grammy, no socket.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { umbrellaInboxFile, orphanInboxFile } from '../../runtime/paths.js';
import type { ChannelsConfig } from '../routing.js';
import type { ChannelAdapter, InboundChatMessage, InboundSubscription } from '../types.js';

import { wireInboundTransport } from './worker.js';

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'cat1b-worker-'));
  process.env.OPENSQUID_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

/** Fake adapter that captures the transport handler so the test can fire it. */
function fakeTransportAdapter(): {
  adapter: Pick<ChannelAdapter, 'subscribeTransport'>;
  fire: (msg: InboundChatMessage) => Promise<void>;
} {
  let handler: ((msg: InboundChatMessage) => Promise<void>) | null = null;
  const adapter: Pick<ChannelAdapter, 'subscribeTransport'> = {
    // eslint-disable-next-line @typescript-eslint/require-await
    subscribeTransport: async (h): Promise<InboundSubscription> => {
      handler = h;
      // eslint-disable-next-line @typescript-eslint/require-await
      return { unsubscribe: async (): Promise<void> => undefined };
    },
  };
  return {
    adapter,
    fire: async (msg): Promise<void> => {
      if (handler !== null) await handler(msg);
    },
  };
}

const CONFIG: ChannelsConfig = {
  v: 1,
  umbrellas: [{ id: 'loop', members: ['/Users/slee/projects/loop'], telegram: { chat_id: '-100', topic_id: 15 } }],
};

describe('wireInboundTransport', () => {
  it('routes a topic-matching inbound message to its umbrella inbox', async () => {
    const { adapter, fire } = fakeTransportAdapter();
    const sub = await wireInboundTransport(adapter, CONFIG);
    expect(sub).not.toBeNull();

    await fire({
      platform: 'telegram',
      messageId: '510',
      chatId: '-100',
      topicId: 15,
      sender: 'L0g1cProphet',
      senderId: '8075471258',
      text: 'hello',
      receivedAt: '2026-06-02T00:00:00.000Z',
      mentionsBot: false,
      direct: false,
    });

    const raw = await readFile(umbrellaInboxFile('loop', 'telegram'), 'utf8');
    const row = JSON.parse(raw.trim()) as Record<string, unknown>;
    const { enqueued_at, ...rest } = row;
    expect(typeof enqueued_at).toBe('string');
    expect(rest).toEqual({
      v: 1,
      id: '510',
      thread_id: '15',
      platform: 'telegram',
      channel: 'telegram:-100',
      sender: 'L0g1cProphet',
      sender_id: '8075471258',
      text: 'hello',
      received_at: '2026-06-02T00:00:00.000Z',
      mentions_bot: false,
    });
  });

  it('orphans a message that resolves to no umbrella', async () => {
    const { adapter, fire } = fakeTransportAdapter();
    await wireInboundTransport(adapter, CONFIG);

    await fire({
      platform: 'telegram',
      messageId: '7',
      chatId: '-999',
      topicId: 3,
      sender: 's',
      senderId: '42',
      text: 'orphan',
      receivedAt: '2026-06-02T00:00:00.000Z',
      mentionsBot: false,
      direct: false,
    });

    const raw = await readFile(orphanInboxFile('telegram'), 'utf8');
    const row = JSON.parse(raw.trim()) as { id: string; channel: string };
    expect(row.id).toBe('7');
    expect(row.channel).toBe('telegram:-999');
  });

  it('returns null when the adapter has no subscribeTransport surface', async () => {
    const sub = await wireInboundTransport({}, CONFIG);
    expect(sub).toBeNull();
  });
});

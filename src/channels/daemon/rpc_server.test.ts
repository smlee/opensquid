/**
 * RPC server + gateway channel-parsing tests (CAT.1b).
 *
 * No grammy: the gateway is driven with a FAKE adapter that records the URI it
 * was asked to send to. The server runs on a real Unix socket under an
 * `mkdtemp` `OPENSQUID_HOME` so the byte-compatible wire contract (the shape
 * `chat-bridge-server.ts` + `agent_bridge/chat_send.ts` parse) is exercised
 * end-to-end.
 */

/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatGateway, parseChannel } from '../gateway.js';
import type { ChannelAdapter, ChannelMessage, SendResult } from '../types.js';

import { daemonSockAddress } from './protocol.js';
import { RpcServer } from './rpc_server.js';

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'cat1b-rpc-'));
  process.env.OPENSQUID_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

/** A recorded `sendPhoto` call (CAT.4). */
interface PhotoCall {
  uri: string;
  path: string;
  caption?: string;
  threadId?: number;
}

/** Fake telegram adapter — records every send URI, returns ok by default.
 *  CAT.4: also exposes a `sendPhoto` that records its args. */
function fakeTelegram(opts: { sendResult?: SendResult } = {}): {
  adapter: ChannelAdapter;
  sentUris: string[];
  photoCalls: PhotoCall[];
} {
  const sentUris: string[] = [];
  const photoCalls: PhotoCall[] = [];
  const adapter: ChannelAdapter & {
    sendPhoto: (
      uri: string,
      o: { path: string; caption?: string; threadId?: number },
    ) => Promise<SendResult>;
  } = {
    scheme: 'telegram',
    validate: () => true,
    send: async (uri: string, _msg: ChannelMessage): Promise<SendResult> => {
      sentUris.push(uri);
      return opts.sendResult ?? { ok: true };
    },
    sendPhoto: async (uri, o): Promise<SendResult> => {
      photoCalls.push({
        uri,
        path: o.path,
        ...(o.caption !== undefined ? { caption: o.caption } : {}),
        ...(o.threadId !== undefined ? { threadId: o.threadId } : {}),
      });
      return opts.sendResult ?? { ok: true, messageId: 'photo-1' };
    },
  };
  return { adapter, sentUris, photoCalls };
}

/** One-shot JSON-RPC call over the daemon socket (mirrors the live callers). */
function rpcCall(address: string, req: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const sock: Socket = connect(address);
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('rpc timeout'));
    }, 3000);
    sock.once('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.once('error', (e: Error) => {
      clearTimeout(t);
      reject(e);
    });
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(t);
      sock.destroy();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

describe('parseChannel', () => {
  it('telegram:<chat> → telegram://<chat>', () => {
    expect(parseChannel('telegram:-1003923174632')).toEqual({
      platform: 'telegram',
      uri: 'telegram://-1003923174632',
    });
  });

  it('telegram:<chat>:<thread> composite → telegram://<chat>/<thread>', () => {
    expect(parseChannel('telegram:-1003923174632:15')).toEqual({
      platform: 'telegram',
      uri: 'telegram://-1003923174632/15',
    });
  });

  it('explicit threadId arg overrides any embedded suffix', () => {
    expect(parseChannel('telegram:-100:15', '99')).toEqual({
      platform: 'telegram',
      uri: 'telegram://-100/99',
    });
  });

  it('throws on a malformed channel (no colon)', () => {
    expect(() => parseChannel('telegram')).toThrow(/malformed channel/);
  });
});

describe('RpcServer over a real Unix socket', () => {
  it('send parses telegram:<chat>:<thread> to the right adapter URI + returns the byte-compatible result', async () => {
    const { adapter, sentUris } = fakeTelegram();
    const gateway = new ChatGateway({ adapters: new Map([['telegram', adapter]]) });
    const server = new RpcServer({ gateway, version: 'test', pid: 4242 });
    await server.listen();
    try {
      const res = (await rpcCall(daemonSockAddress(), {
        jsonrpc: '2.0',
        id: 1,
        method: 'send',
        params: { channel: 'telegram:-1003923174632:15', text: 'hello' },
      })) as { result: { ok: boolean; platform: string; message_id: string; delivered_at: string } };
      expect(sentUris).toEqual(['telegram://-1003923174632/15']);
      expect(res.result.ok).toBe(true);
      expect(res.result.platform).toBe('telegram');
      expect(typeof res.result.message_id).toBe('string');
      expect(typeof res.result.delivered_at).toBe('string');
      // delivered_at is an ISO-8601 string.
      expect(Number.isNaN(Date.parse(res.result.delivered_at))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('send with mediaPath routes to sendPhoto (text → caption)', async () => {
    const { adapter, sentUris, photoCalls } = fakeTelegram();
    const gateway = new ChatGateway({ adapters: new Map([['telegram', adapter]]) });
    const server = new RpcServer({ gateway, version: 'test' });
    await server.listen();
    try {
      const res = (await rpcCall(daemonSockAddress(), {
        jsonrpc: '2.0',
        id: 10,
        method: 'send',
        params: {
          channel: 'telegram:-100:15',
          text: 'a caption',
          mediaPath: '/abs/pic.png',
        },
      })) as { result: { ok: boolean; platform: string; message_id: string } };
      // Routed to sendPhoto, NOT the text send.
      expect(sentUris).toEqual([]);
      expect(photoCalls).toEqual([
        { uri: 'telegram://-100/15', path: '/abs/pic.png', caption: 'a caption' },
      ]);
      expect(res.result.ok).toBe(true);
      expect(res.result.message_id).toBe('photo-1');
    } finally {
      await server.close();
    }
  });

  it('send surfaces an adapter failure as a JSON-RPC error', async () => {
    const { adapter } = fakeTelegram({ sendResult: { ok: false, error: 'chat not in allowlist' } });
    const gateway = new ChatGateway({ adapters: new Map([['telegram', adapter]]) });
    const server = new RpcServer({ gateway });
    await server.listen();
    try {
      const res = (await rpcCall(daemonSockAddress(), {
        jsonrpc: '2.0',
        id: 2,
        method: 'send',
        params: { channel: 'telegram:999', text: 'x' },
      })) as { error?: { code: number; message: string } };
      expect(res.error).toBeDefined();
      expect(res.error?.message).toContain('chat not in allowlist');
    } finally {
      await server.close();
    }
  });

  it('ping returns {pong:true, pid, version}', async () => {
    const { adapter } = fakeTelegram();
    const gateway = new ChatGateway({ adapters: new Map([['telegram', adapter]]) });
    const server = new RpcServer({ gateway, version: 'v-test', pid: 777 });
    await server.listen();
    try {
      const res = (await rpcCall(daemonSockAddress(), {
        jsonrpc: '2.0',
        id: 3,
        method: 'ping',
      })) as { result: { pong: boolean; pid: number; version: string } };
      expect(res.result).toEqual({ pong: true, pid: 777, version: 'v-test' });
    } finally {
      await server.close();
    }
  });

  it('list_channels returns the active platforms', async () => {
    const { adapter } = fakeTelegram();
    const gateway = new ChatGateway({ adapters: new Map([['telegram', adapter]]) });
    const server = new RpcServer({ gateway });
    await server.listen();
    try {
      const res = (await rpcCall(daemonSockAddress(), {
        jsonrpc: '2.0',
        id: 4,
        method: 'list_channels',
      })) as { result: { active_platforms: string[]; uptime_ms: number | null } };
      expect(res.result.active_platforms).toEqual(['telegram']);
      expect(typeof res.result.uptime_ms).toBe('number');
    } finally {
      await server.close();
    }
  });

  it('create_topic dispatches to the gateway createTopic seam', async () => {
    const { adapter } = fakeTelegram();
    const gateway = new ChatGateway({
      adapters: new Map([['telegram', adapter]]),
      createTopic: async (a) => ({ message_thread_id: 55, name: a.name }),
    });
    const server = new RpcServer({ gateway });
    await server.listen();
    try {
      const res = (await rpcCall(daemonSockAddress(), {
        jsonrpc: '2.0',
        id: 5,
        method: 'create_topic',
        params: { platform: 'telegram', chat_id: '-100', name: 'loop' },
      })) as { result: { message_thread_id: number; name: string } };
      expect(res.result).toEqual({ message_thread_id: 55, name: 'loop' });
    } finally {
      await server.close();
    }
  });

  it('unknown method → JSON-RPC method-not-found', async () => {
    const { adapter } = fakeTelegram();
    const gateway = new ChatGateway({ adapters: new Map([['telegram', adapter]]) });
    const server = new RpcServer({ gateway });
    await server.listen();
    try {
      const res = (await rpcCall(daemonSockAddress(), {
        jsonrpc: '2.0',
        id: 6,
        method: 'subscribe',
      })) as { error?: { code: number } };
      expect(res.error?.code).toBe(-32601);
    } finally {
      await server.close();
    }
  });
});

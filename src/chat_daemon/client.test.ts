import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { daemonRpc, daemonSocketPath, sendChat } from './client.js';

let home: string;
let prior: string | undefined;
let server: Server | null = null;
let conns: Socket[] = [];

beforeEach(async () => {
  prior = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-chatclient-'));
  process.env.OPENSQUID_HOME = home;
  conns = [];
});
afterEach(async () => {
  for (const c of conns) c.destroy(); // force-close (the never-replies test leaves one half-open)
  conns = [];
  if (server !== null) {
    await new Promise<void>((res) => server?.close(() => res()));
    server = null;
  }
  if (prior === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = prior;
  await rm(home, { recursive: true, force: true });
});

interface RpcReq {
  id: unknown;
  method: string;
  params?: unknown;
}

/** A stub daemon on the canonical sock path; `onConn` wires each accepted socket. */
async function startServer(onConn: (sock: Socket) => void): Promise<void> {
  server = createServer((sock) => {
    conns.push(sock);
    onConn(sock);
  });
  await new Promise<void>((res) => server?.listen(daemonSocketPath(), () => res()));
}

/** Reply to one newline-framed request with `responder(req)`. */
function startStub(responder: (req: RpcReq) => unknown): Promise<void> {
  return startServer((sock) => {
    let buf = '';
    sock.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as RpcReq;
      sock.write(JSON.stringify(responder(req)) + '\n');
    });
  });
}

describe('chat_daemon client (CL.1)', () => {
  it('daemonSocketPath resolves the canonical sock under OPENSQUID_HOME (non-win32)', () => {
    if (process.platform === 'win32') return;
    expect(daemonSocketPath()).toBe(join(home, 'chat-daemon.sock'));
  });

  it('daemonRpc round-trips a result for any method', async () => {
    await startStub((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: { ok: true, echoed: req.method },
    }));
    const r = await daemonRpc<{ ok: boolean; echoed: string }>('ping', { x: 1 });
    expect(r).toEqual({ ok: true, echoed: 'ping' });
  });

  it('sendChat decodes the DaemonSendResult', async () => {
    await startStub((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      result: { ok: true, platform: 'telegram', message_id: '42', delivered_at: 't' },
    }));
    const r = await sendChat({ channel: 'project:telegram', text: 'hi' });
    expect(r).toEqual({ ok: true, platform: 'telegram', message_id: '42', delivered_at: 't' });
  });

  it('rejects on an RPC error envelope', async () => {
    await startStub((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32000, message: 'boom' },
    }));
    await expect(daemonRpc('send', {})).rejects.toThrow(/RPC error -32000: boom/);
  });

  it('rejects with a connection error when no daemon is listening', async () => {
    await expect(daemonRpc('send', {}, { timeoutMs: 1000 })).rejects.toThrow(/connection error/);
  });

  it('times out when the daemon accepts but never replies', async () => {
    await startServer(() => {
      /* accept, never respond */
    });
    await expect(daemonRpc('send', {}, { timeoutMs: 300 })).rejects.toThrow(/timeout after 300ms/);
  });
});

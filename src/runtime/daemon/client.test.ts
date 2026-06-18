/** DAEMON.1 — the thin client (ensureRunning reuse + token-authed send + dead-host detection). */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHost, type HostHandle } from './host.js';
import { ensureRunning, ping, send } from './client.js';
import { writeRuntimeState } from './state_file.js';

let home: string;
const live: HostHandle[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-client-'));
});
afterEach(async () => {
  for (const h of live.splice(0)) await h.stop('test-cleanup').catch(() => undefined);
});

async function boot(): Promise<HostHandle> {
  const h = await startHost({ home });
  live.push(h);
  return h;
}

describe('client ensureRunning / send (DAEMON.1)', () => {
  it('reuses a live host (no second spawn): returns its port + token', async () => {
    const h = await boot();
    const st = await ensureRunning(home);
    expect(st).toMatchObject({ port: h.port, token: h.token });
  });

  it('send routes a token-authed envelope to the live host', async () => {
    const h = await boot();
    const got: unknown[] = [];
    h.bus.subscribe(
      (e) => e.kind === 'tool_call',
      (e) => got.push(e.payload),
    );
    const out = await send(
      { seq: 1, from: 'c', to: 'topic:t', kind: 'tool_call', payload: { hi: true }, ts: 0 },
      home,
    );
    expect(out).toEqual({ ok: true });
    expect(got).toEqual([{ hi: true }]);
  });

  it('ping detects a dead host (stale runtime.json → unreachable port)', async () => {
    // a runtime.json that points at a port nobody is listening on
    await writeRuntimeState({ port: 59997, token: 'stale', pid: 1, startedAt: 0 }, home);
    expect(await ping(59997, 'stale')).toBe(false);
  });

  it('ping returns true for a live, correctly-tokened host', async () => {
    const h = await boot();
    expect(await ping(h.port, h.token)).toBe(true);
    expect(await ping(h.port, 'wrong-token')).toBe(false); // token mismatch ⇒ not "ours"
  });
});

/** DAEMON.1 — the runtime host (lifecycle FSM, localhost+token, single-instance, graceful shutdown). */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateFsm } from '../fsm.js';
import { readShutdownMarker } from '../genesis/shutdown_marker.js';
import { HOST_FSM, startHost, type HostHandle } from './host.js';
import { readRuntimeState } from './state_file.js';

let home: string;
const live: HostHandle[] = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-host-'));
});
afterEach(async () => {
  for (const h of live.splice(0)) await h.stop('test-cleanup').catch(() => undefined);
});

async function boot(idleMs = 30 * 60_000): Promise<HostHandle> {
  const h = await startHost({ home, idleMs });
  live.push(h);
  return h;
}

describe('host lifecycle FSM (DAEMON.1)', () => {
  it('HOST_FSM is a valid total FSM (idle→starting→running→draining→stopped)', () => {
    expect(validateFsm(HOST_FSM)).toEqual([]);
    expect(HOST_FSM.initial).toBe('idle');
  });

  it('reaches `running` after start and writes runtime.json', async () => {
    const h = await boot();
    expect(h.state()).toBe('running');
    const st = await readRuntimeState(home);
    expect(st).toMatchObject({ port: h.port, token: h.token, pid: process.pid });
  });
});

describe('host server: localhost + token auth (DAEMON.1)', () => {
  it('rejects a request without the token (401)', async () => {
    const h = await boot();
    const res = await fetch(`http://127.0.0.1:${h.port}/ping`);
    expect(res.status).toBe(401);
  });

  it('routes a token-authed /envelope POST onto the bus (200)', async () => {
    const h = await boot();
    const received: unknown[] = [];
    h.bus.subscribe(
      (e) => e.kind === 'tool_call',
      (e) => received.push(e.payload),
    );
    const env = {
      seq: 1,
      from: 'client',
      to: 'topic:t',
      kind: 'tool_call',
      payload: { x: 1 },
      ts: 0,
    };
    const res = await fetch(`http://127.0.0.1:${h.port}/envelope`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(env),
    });
    expect(res.status).toBe(200);
    expect(received).toEqual([{ x: 1 }]);
  });
});

describe('host single-instance + graceful shutdown (DAEMON.1)', () => {
  it('a second startHost on the same HOME defers (boot lock = first-owns-topology)', async () => {
    await boot();
    await expect(startHost({ home })).rejects.toThrow(/boot lock|owns the runtime/);
  });

  it('graceful stop writes the GR.1 marker, unlinks runtime.json, reaches `stopped`', async () => {
    const h = await startHost({ home });
    await h.stop('test');
    expect(h.state()).toBe('stopped');
    expect(await readRuntimeState(home)).toBeNull(); // discovery file unlinked
    expect(await readShutdownMarker(home)).toMatchObject({ status: 'clean' }); // clean-resume signal
  });

  it('stop is exactly-once (a second stop is a no-op)', async () => {
    const h = await startHost({ home });
    await h.stop('first');
    await expect(h.stop('second')).resolves.toBeUndefined();
    // lock was released exactly once → a fresh host can boot
    const h2 = await boot();
    expect(h2.state()).toBe('running');
  });
});

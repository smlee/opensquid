/**
 * Interactive responder — tests for claimUmbrellaLeaseForSession.
 * The live session claims its umbrella lease (acquire-if-free) so the Stop-hook
 * drive owns the turn; a second same-umbrella session stays local-only; headless
 * mode yields.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelsConfigPath } from '../../channels/routing.js';
import { umbrellaLiveSessionLease } from '../paths.js';

import { claimUmbrellaLeaseForSession } from './claim_lease.js';
import { readLease, writeLease } from './live_session_lease.js';

const CWD = '/x/loop';
const SESSION = 'cc-session-abc';

async function seedChannels(responder?: 'session' | 'headless'): Promise<void> {
  await writeFile(
    channelsConfigPath(),
    JSON.stringify({
      v: 1,
      umbrellas: [{ id: 'loop', members: [CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
      ...(responder !== undefined ? { responder } : {}),
    }),
    'utf8',
  );
}

describe('claimUmbrellaLeaseForSession', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'claim-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it('claims the umbrella lease with the session id when free', async () => {
    await seedChannels();
    expect(await claimUmbrellaLeaseForSession(SESSION, CWD)).toBe(true);
    const lease = await readLease(umbrellaLiveSessionLease('loop'));
    expect(lease?.session_id).toBe(SESSION);
  });

  it('does NOT steal a fresh lease held by a different session (local-only #6)', async () => {
    await seedChannels();
    await writeLease(umbrellaLiveSessionLease('loop'), 'other-session');
    expect(await claimUmbrellaLeaseForSession(SESSION, CWD)).toBe(false);
    const lease = await readLease(umbrellaLiveSessionLease('loop'));
    expect(lease?.session_id).toBe('other-session');
  });

  it('re-claims a stale lease', async () => {
    await seedChannels();
    const stale = new Date(Date.now() - 5 * 60_000);
    await writeLease(umbrellaLiveSessionLease('loop'), 'old-session', stale);
    expect(await claimUmbrellaLeaseForSession(SESSION, CWD)).toBe(true);
    expect((await readLease(umbrellaLiveSessionLease('loop')))?.session_id).toBe(SESSION);
  });

  // T-CHAT-REALTIME: a SESSION START takes over even a FRESH lease held by a different
  // session — the session changed (new live session for the same project), so chat
  // routes to the newest. (The mid-session heartbeat without forceTakeover still defers.)
  it('forceTakeover steals a FRESH lease held by a different session (session changed)', async () => {
    await seedChannels();
    await writeLease(umbrellaLiveSessionLease('loop'), 'prior-session'); // fresh, different
    // default heartbeat defers (invariant #6)…
    expect(await claimUmbrellaLeaseForSession(SESSION, CWD)).toBe(false);
    // …but a session start force-takes-over.
    expect(await claimUmbrellaLeaseForSession(SESSION, CWD, { forceTakeover: true })).toBe(true);
    expect((await readLease(umbrellaLiveSessionLease('loop')))?.session_id).toBe(SESSION);
  });

  it('yields (no claim) in responder: headless mode', async () => {
    await seedChannels('headless');
    expect(await claimUmbrellaLeaseForSession(SESSION, CWD)).toBe(false);
    expect(await readLease(umbrellaLiveSessionLease('loop'))).toBeNull();
  });

  it('no-ops when cwd resolves to no umbrella', async () => {
    await seedChannels();
    expect(await claimUmbrellaLeaseForSession(SESSION, '/elsewhere')).toBe(false);
  });

  it('no-ops when channels.json is absent', async () => {
    expect(await claimUmbrellaLeaseForSession(SESSION, CWD)).toBe(false);
  });

  it('no-ops for an unknown/empty session id', async () => {
    await seedChannels();
    expect(await claimUmbrellaLeaseForSession('unknown', CWD)).toBe(false);
    expect(await claimUmbrellaLeaseForSession('', CWD)).toBe(false);
  });
});

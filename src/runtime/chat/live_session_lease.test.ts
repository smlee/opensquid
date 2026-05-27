/**
 * Tests for the live-session lease (Track T-DEL, DEL.1).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { liveSessionLease } from '../paths.js';

import {
  STALE_MS,
  isLeaseFresh,
  readLease,
  refreshLease,
  removeLease,
  resolveSessionId,
  writeLease,
  type LiveSessionLease,
} from './live_session_lease.js';

const UUID = 'proj-del';
let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lease-'));
  savedHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe('live-session lease', () => {
  it('writes (creating the dir) and round-trips a lease', async () => {
    const now = new Date('2026-05-27T12:00:00Z');
    await writeLease(UUID, 'sess-1', now);
    const lease = await readLease(UUID);
    expect(lease?.session_id).toBe('sess-1');
    expect(lease?.pid).toBe(process.pid);
    expect(lease?.refreshed_at).toBe(now.toISOString());
  });

  it('reads null for an absent lease', async () => {
    expect(await readLease('no-such-uuid')).toBeNull();
  });

  it('reads null for a malformed lease file', async () => {
    await writeLease(UUID, 'sess-1'); // creates the dir
    await writeFile(liveSessionLease(UUID), 'not json', 'utf8');
    expect(await readLease(UUID)).toBeNull();
  });

  it('isLeaseFresh: now → fresh, beyond STALE_MS → stale, null → not fresh', () => {
    const base = new Date('2026-05-27T12:00:00Z');
    const fresh: LiveSessionLease = { session_id: 's', pid: 1, refreshed_at: base.toISOString() };
    expect(isLeaseFresh(fresh, base)).toBe(true);
    expect(isLeaseFresh(fresh, new Date(base.getTime() + STALE_MS - 1))).toBe(true);
    expect(isLeaseFresh(fresh, new Date(base.getTime() + STALE_MS + 1))).toBe(false);
    expect(isLeaseFresh(null, base)).toBe(false);
  });

  it('isLeaseFresh: malformed/negative-age dates are not fresh', () => {
    const now = new Date('2026-05-27T12:00:00Z');
    expect(isLeaseFresh({ session_id: 's', pid: 1, refreshed_at: 'garbage' }, now)).toBe(false);
    // future timestamp (clock skew) → negative age → not fresh
    const future = new Date(now.getTime() + 10_000).toISOString();
    expect(isLeaseFresh({ session_id: 's', pid: 1, refreshed_at: future }, now)).toBe(false);
  });

  it('refreshLease advances refreshed_at while keeping session_id', async () => {
    const t0 = new Date('2026-05-27T12:00:00Z');
    await writeLease(UUID, 'sess-keep', t0);
    const t1 = new Date('2026-05-27T12:00:45Z');
    await refreshLease(UUID, t1);
    const lease = await readLease(UUID);
    expect(lease?.session_id).toBe('sess-keep');
    expect(lease?.refreshed_at).toBe(t1.toISOString());
  });

  it('removeLease deletes the lease and is a no-op when absent', async () => {
    await writeLease(UUID, 'sess-1');
    await removeLease(UUID);
    expect(await readLease(UUID)).toBeNull();
    await removeLease(UUID); // no throw on already-gone
  });

  it('resolveSessionId prefers CLAUDE_SESSION_ID, falls back to pid', () => {
    expect(resolveSessionId({ CLAUDE_SESSION_ID: 'cs' })).toBe('cs');
    expect(resolveSessionId({ OPENSQUID_SESSION_ID: 'os' })).toBe('os');
    expect(resolveSessionId({})).toBe(`pid-${process.pid}`);
  });
});

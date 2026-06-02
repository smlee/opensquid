/**
 * agent_bridge — HeadlessLeaseManager unit tests (T-CHAT-AS-TERMINAL CAT.5).
 *
 * The headless lease state machine drives WHO holds an umbrella's chat lease
 * when no human session is live. These tests write leases DIRECTLY (to
 * simulate human / headless / stale holders) under a mkdtemp OPENSQUID_HOME,
 * with an injected clock + injected timers so NO real interval fires and NO
 * agent loop / SDK is ever touched (token-free by construction — this module
 * imports neither the agent loop nor any SDK).
 *
 * Coverage:
 *   - acquireIfFree: no lease → acquires; fresh human → stands down; stale →
 *     reclaims; already-ours-fresh → keeps.
 *   - handoff: human appears mid-hold → tick stands down (process stays); the
 *     human lease goes stale → tick re-acquires.
 *   - heartbeat: refreshes only while held; never writes while stood down.
 *   - start/stop: start acquires + arms the ticker; stop releases OUR lease
 *     only (never a human's) + is idempotent.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { umbrellaLiveSessionLease } from '../paths.js';
import {
  type LiveSessionLease,
  readLease,
} from '../chat/live_session_lease.js';

import { HeadlessLeaseManager, headlessSessionId } from './headless_lease.js';

const UMB = 'loop';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cat5-headless-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

/** Write a lease file directly to simulate an arbitrary holder. */
async function seedLease(sessionId: string, refreshedAt: Date): Promise<void> {
  const path = umbrellaLiveSessionLease(UMB);
  await mkdir(dirname(path), { recursive: true });
  const lease: LiveSessionLease = {
    session_id: sessionId,
    pid: 99999,
    refreshed_at: refreshedAt.toISOString(),
  };
  await writeFile(path, JSON.stringify(lease), 'utf8');
}

async function leaseOnDisk(): Promise<LiveSessionLease | null> {
  return readLease(umbrellaLiveSessionLease(UMB));
}

/** A manager with an injected clock + NO-OP timers (start arms nothing real). */
function makeManager(now: () => Date): HeadlessLeaseManager {
  return new HeadlessLeaseManager({
    umbrellaId: UMB,
    now,
    // Inject a timer that NEVER fires — tests drive tick() by hand.
    setIntervalFn: () => ({ unref: () => undefined }) as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => undefined,
  });
}

const NOW = new Date('2026-06-02T12:00:00.000Z');
const minus = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('HeadlessLeaseManager.acquireIfFree', () => {
  it('no lease → acquires (writes the headless lease) + holds', async () => {
    const mgr = makeManager(() => NOW);
    expect(await mgr.acquireIfFree()).toBe(true);
    expect(mgr.isHolding).toBe(true);
    const lease = await leaseOnDisk();
    expect(lease?.session_id).toBe(headlessSessionId(UMB));
  });

  it('fresh HUMAN lease → stands down (no write, does not hold)', async () => {
    await seedLease('human-terminal-session', minus(5_000)); // fresh
    const mgr = makeManager(() => NOW);
    expect(await mgr.acquireIfFree()).toBe(false);
    expect(mgr.isHolding).toBe(false);
    // The human lease is untouched.
    const lease = await leaseOnDisk();
    expect(lease?.session_id).toBe('human-terminal-session');
  });

  it('STALE lease → reclaims (writes our lease over the stale one)', async () => {
    await seedLease('crashed-watch', minus(120_000)); // > STALE_MS (90s)
    const mgr = makeManager(() => NOW);
    expect(await mgr.acquireIfFree()).toBe(true);
    expect(mgr.isHolding).toBe(true);
    const lease = await leaseOnDisk();
    expect(lease?.session_id).toBe(headlessSessionId(UMB));
  });

  it('already-OURS fresh lease → keeps (idempotent re-acquire)', async () => {
    await seedLease(headlessSessionId(UMB), minus(5_000)); // fresh + ours
    const mgr = makeManager(() => NOW);
    expect(await mgr.acquireIfFree()).toBe(true);
    expect(mgr.isHolding).toBe(true);
    const lease = await leaseOnDisk();
    expect(lease?.session_id).toBe(headlessSessionId(UMB));
  });
});

describe('HeadlessLeaseManager.tick — heartbeat + handoff + reclaim', () => {
  it('heartbeat: refreshes ONLY while held (timestamp advances)', async () => {
    let clock = NOW;
    const mgr = makeManager(() => clock);
    await mgr.acquireIfFree();
    const t0 = (await leaseOnDisk())?.refreshed_at;

    clock = new Date(NOW.getTime() + 10_000);
    await mgr.tick();
    const t1 = (await leaseOnDisk())?.refreshed_at;

    expect(mgr.isHolding).toBe(true);
    expect(t1).not.toBe(t0); // heartbeat advanced the timestamp (fs touch)
    expect(new Date(t1!).getTime()).toBeGreaterThan(new Date(t0!).getTime());
    expect((await leaseOnDisk())?.session_id).toBe(headlessSessionId(UMB));
  });

  it('handoff: a human lease appears mid-hold → tick stands down (process stays, no write)', async () => {
    let clock = NOW;
    const mgr = makeManager(() => clock);
    await mgr.acquireIfFree();
    expect(mgr.isHolding).toBe(true);

    // Human takes over: overwrite with a fresh foreign lease.
    clock = new Date(NOW.getTime() + 5_000);
    await seedLease('human-terminal-session', clock);

    await mgr.tick();
    expect(mgr.isHolding).toBe(false); // stood down
    // We did NOT clobber the human lease.
    expect((await leaseOnDisk())?.session_id).toBe('human-terminal-session');
  });

  it('reclaim: while stood down, the human lease goes stale → tick re-acquires', async () => {
    let clock = NOW;
    const mgr = makeManager(() => clock);
    // Start stood down (a fresh human holds it).
    await seedLease('human-terminal-session', clock);
    expect(await mgr.acquireIfFree()).toBe(false);
    expect(mgr.isHolding).toBe(false);

    // Human goes away; 120s later their lease is stale.
    clock = new Date(NOW.getTime() + 120_000);
    await mgr.tick();

    expect(mgr.isHolding).toBe(true); // re-acquired
    expect((await leaseOnDisk())?.session_id).toBe(headlessSessionId(UMB));
  });

  it('stays stood down while a fresh foreign lease persists (no clobber)', async () => {
    let clock = NOW;
    const mgr = makeManager(() => clock);
    await seedLease('human-terminal-session', clock);
    await mgr.acquireIfFree();

    clock = new Date(NOW.getTime() + 10_000);
    await seedLease('human-terminal-session', clock); // human heartbeats too
    await mgr.tick();

    expect(mgr.isHolding).toBe(false);
    expect((await leaseOnDisk())?.session_id).toBe('human-terminal-session');
  });
});

describe('HeadlessLeaseManager.start / stop', () => {
  it('start acquires-if-free + arms the ticker (idempotent)', async () => {
    const mgr = makeManager(() => NOW);
    await mgr.start();
    expect(mgr.isHolding).toBe(true);
    await mgr.start(); // idempotent — no throw, still holding
    expect(mgr.isHolding).toBe(true);
  });

  it('stop releases OUR lease only + is idempotent', async () => {
    const mgr = makeManager(() => NOW);
    await mgr.start();
    expect(await leaseOnDisk()).not.toBeNull();
    await mgr.stop();
    expect(await leaseOnDisk()).toBeNull(); // our lease removed
    expect(mgr.isHolding).toBe(false);
    await mgr.stop(); // idempotent
  });

  it('stop NEVER removes a human lease (only ours)', async () => {
    const mgr = makeManager(() => NOW);
    await mgr.start();
    // A human takes over before shutdown.
    await seedLease('human-terminal-session', NOW);
    await mgr.stop();
    // The human lease survives.
    expect((await leaseOnDisk())?.session_id).toBe('human-terminal-session');
  });

  it('start after stop throws (single-use)', async () => {
    const mgr = makeManager(() => NOW);
    await mgr.start();
    await mgr.stop();
    await expect(mgr.start()).rejects.toThrow(/cannot restart/);
  });
});

describe('HeadlessLeaseManager — token-free heartbeat (no agent loop / SDK)', () => {
  it('the module never imports the agent loop or any SDK (source audit)', async () => {
    // Structural proof: the heartbeat path is pure fs. We assert the source
    // imports only the lease primitive + paths — never agent_loop*, batch,
    // dispatcher, session_manager, or @anthropic-ai/sdk.
    const src = await readFile(new URL('./headless_lease.ts', import.meta.url), 'utf8');
    const importLines = src.split('\n').filter((l) => l.trimStart().startsWith('import '));
    const joined = importLines.join('\n');
    expect(joined).not.toMatch(/agent_loop/);
    expect(joined).not.toMatch(/\.\/batch/);
    expect(joined).not.toMatch(/\.\/dispatcher/);
    expect(joined).not.toMatch(/\.\/session_manager/);
    expect(joined).not.toMatch(/@anthropic-ai\/sdk/);
    expect(joined).not.toMatch(/anthropic/i);
  });
});

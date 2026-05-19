/**
 * Tests for `notifyAndPause` / `isPaused` / `readPauseState` (Task 1.18).
 *
 * Per task acceptance criteria: ≥ 4 cases — happy path, post-pause
 * `isPaused === true`, post-delete `isPaused === false`, and the C10
 * "multicast throws → pause state still written" failure path.
 *
 * Filesystem isolation matches `src/functions/state.test.ts`:
 * `mkdtemp(tmpdir())` per test, `OPENSQUID_HOME` pointed at it,
 * env-var restored + temp dir removed in `afterEach`.
 *
 * The router is a hand-rolled stub keyed off a `multicastImpl` mock so
 * individual tests can swap in throwing / counting / inspecting bodies
 * without taking on `vi.mock` or the full channels adapter stack.
 */

import { mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationRouter, MulticastResult } from '../channels/router.js';
import type { ChannelMessage, RoutingConfig, Severity } from '../channels/types.js';

import { isPaused, notifyAndPause, readPauseState } from './failure_handling.js';
import { sessionStateDir, sessionStateFile } from './paths.js';
import type { PauseState } from './types.js';

// ---------------------------------------------------------------------------
// Per-test scaffolding — OPENSQUID_HOME isolation + stub router builder.
// ---------------------------------------------------------------------------

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-failure-handling-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

interface StubRouter {
  router: NotificationRouter;
  multicast: ReturnType<typeof vi.fn>;
  calls: { severity: Severity; project: string | null; message: ChannelMessage }[];
}

function makeStubRouter(
  impl: (
    severity: Severity,
    project: string | null,
    message: ChannelMessage,
  ) => Promise<MulticastResult> = () =>
    Promise.resolve<MulticastResult>({ sent: 1, failed: 0, errors: [] }),
): StubRouter {
  const calls: StubRouter['calls'] = [];
  const multicast = vi.fn(
    async (
      severity: Severity,
      project: string | null,
      message: ChannelMessage,
      _config: RoutingConfig,
    ): Promise<MulticastResult> => {
      calls.push({ severity, project, message });
      return impl(severity, project, message);
    },
  );
  // Cast through `unknown` — we only need `multicast` for these tests, and
  // the production type has private fields we cannot satisfy from a stub.
  const router = { multicast } as unknown as NotificationRouter;
  return { router, multicast, calls };
}

const routing: RoutingConfig = {
  severityTiers: {
    critical: ['chat'],
    error: ['chat'],
    warning: ['chat'],
    info: ['chat'],
  },
  channelMapping: {},
};

const sessionId = (): string => `sess-${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('notifyAndPause', () => {
  it('writes pause.json atomically and multicasts once', async () => {
    const sid = sessionId();
    const stub = makeStubRouter();

    await notifyAndPause('bad pack', sid, stub.router, routing, {
      ruleId: 'r1',
      packId: 'p1',
    });

    const raw = await readFile(sessionStateFile(sid, 'pause'), 'utf8');
    const parsed = JSON.parse(raw) as PauseState;
    expect(parsed.reason).toBe('bad pack');
    expect(parsed.ruleId).toBe('r1');
    expect(parsed.packId).toBe('p1');
    expect(typeof parsed.triggeredAt).toBe('string');
    // ISO-8601 round-trip
    expect(Number.isNaN(Date.parse(parsed.triggeredAt))).toBe(false);

    expect(stub.multicast).toHaveBeenCalledTimes(1);
    expect(stub.calls[0]?.severity).toBe('error');
    expect(stub.calls[0]?.project).toBeNull();
    expect(stub.calls[0]?.message.text).toContain('bad pack');
    expect(stub.calls[0]?.message.severity).toBe('error');

    // Atomicity: no `.tmp.*` artifacts left behind in the state dir.
    const dir = sessionStateDir(sid);
    const entries = await readdir(dir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
    expect(entries).toContain('pause.json');
  });

  it('isPaused returns true after notifyAndPause and false after delete', async () => {
    const sid = sessionId();
    const stub = makeStubRouter();

    expect(await isPaused(sid)).toBe(false);

    await notifyAndPause('halted', sid, stub.router, routing);
    expect(await isPaused(sid)).toBe(true);

    await unlink(sessionStateFile(sid, 'pause'));
    expect(await isPaused(sid)).toBe(false);
  });

  it('pause state IS written even when multicast throws (C10)', async () => {
    const sid = sessionId();
    const stub = makeStubRouter(() => Promise.reject(new Error('every adapter blew up')));

    // Must not throw out of notifyAndPause — multicast failure is logged
    // and swallowed because the pause file is the load-bearing side effect.
    await expect(
      notifyAndPause('multicast-broken', sid, stub.router, routing),
    ).resolves.toBeUndefined();

    // Pause-state file landed on disk despite the notification failure.
    expect(await isPaused(sid)).toBe(true);
    const state = await readPauseState(sid);
    expect(state?.reason).toBe('multicast-broken');
    expect(stub.multicast).toHaveBeenCalledTimes(1);
  });

  it('readPauseState returns full PauseState shape (or null)', async () => {
    const sid = sessionId();
    const stub = makeStubRouter();

    // Before any pause: null.
    expect(await readPauseState(sid)).toBeNull();

    await notifyAndPause('shape-check', sid, stub.router, routing, {
      ruleId: 'rule-42',
      packId: 'pack-7',
    });
    const state = await readPauseState(sid);
    expect(state).not.toBeNull();
    expect(state?.reason).toBe('shape-check');
    expect(state?.ruleId).toBe('rule-42');
    expect(state?.packId).toBe('pack-7');
    expect(typeof state?.triggeredAt).toBe('string');
  });

  it('omits optional meta fields when not supplied', async () => {
    const sid = sessionId();
    const stub = makeStubRouter();

    await notifyAndPause('no-meta', sid, stub.router, routing);
    const state = await readPauseState(sid);
    expect(state?.reason).toBe('no-meta');
    expect(state?.ruleId).toBeUndefined();
    expect(state?.packId).toBeUndefined();
  });
});

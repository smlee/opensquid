/**
 * agent_bridge — transport bridge unit tests (WAB.2).
 */

import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentEventBus } from './event_bus.js';
import { InboxTransportBridge, type TransportBridgeOptions } from './transport_bridge.js';
import type { InboundChatEvent } from './types.js';

const TEST_PROJECT_UUID = '00000000-0000-0000-0000-000000000001';

let tmpRoot: string;
let inboxDir: string;
let inboxFile: string;
let bus: AgentEventBus;
let received: InboundChatEvent[];
let warnings: string[];
let events: Record<string, number>;
let bridge: InboxTransportBridge | null;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opensquid-agent-bridge-test-'));
  inboxDir = path.join(tmpRoot, 'inbox');
  inboxFile = path.join(inboxDir, 'telegram.jsonl');
  await fs.mkdir(inboxDir, { recursive: true });
  bus = new AgentEventBus();
  received = [];
  warnings = [];
  events = {};
  bus.on('inbound', (e) => received.push(e));
  bridge = null;
});

afterEach(async () => {
  if (bridge) await bridge.shutdown();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Wait until either `pred()` returns truthy OR timeout. 15s default (raised
 *  from 2s, then 5s — shared-runner contention); on timeout the error renders
 *  the full `snap()` state so a flake occurrence is its own post-mortem
 *  (T-FLAKE-TRANSPORT-BRIDGE — two budget raises did NOT fix the flake; the
 *  next lever is evidence, not budget). */
async function waitFor(label: string, pred: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `timeout waiting for ${label} after ${Date.now() - start}ms :: ${JSON.stringify(snap())}`,
  );
}

/** T-FLAKE-TRANSPORT-BRIDGE: full state snapshot rendered into every waitFor
 *  timeout — the next natural flake occurrence becomes its own post-mortem
 *  (received/cursor/stat/warnings/event-counts discriminate the seven
 *  undefined-cursor paths; pre-research v6). Every probe is try/catch-bounded
 *  so the snapshot can never mask the original timeout. */
function snap(): Record<string, unknown> {
  return {
    received: received.length,
    firstId: received[0]?.messageId,
    lastId: received.at(-1)?.messageId,
    cursor: bridge?.cursorFor(inboxFile),
    stat: (() => {
      try {
        const s = statSync(inboxFile);
        return { size: s.size, mtimeMs: s.mtimeMs };
      } catch (e) {
        return String(e);
      }
    })(),
    warnings,
    events,
  };
}

function legacyRow(opts: {
  id: string;
  channel: string;
  senderId: string;
  text: string;
  threadId?: string;
}): string {
  const row = {
    v: 1,
    id: opts.id,
    ...(opts.threadId !== undefined ? { thread_id: opts.threadId } : {}),
    platform: 'telegram',
    channel: opts.channel,
    sender: 'L0g1cProphet',
    sender_id: opts.senderId,
    text: opts.text,
    received_at: '2026-05-21T19:00:00.000Z',
    enqueued_at: '2026-05-21T19:00:00.500Z',
    mentions_bot: false,
  };
  return JSON.stringify(row) + '\n';
}

// LP5F.1 follow-up / FX.1: chokidar polling-backend tests occasionally exceed the
// vitest default 5s on shared GitHub Actions runners under contention. Locally every
// test passes in <1s; the extra budget only matters in CI.
// MUST be at MODULE TOP-LEVEL, not in a beforeAll: vitest captures a test's timeout at
// it() REGISTRATION (collection time). A beforeAll runs at EXECUTION (after collection),
// so the bump lands too late and every it() keeps the 5s default — which is exactly why
// the CAT.5 polling test flaked at ~5011ms in CI (the 5s cap, not the 15s waitFor
// ceiling). At top level this runs during collection, before any it() registers.
vi.setConfig({ testTimeout: 20_000 });

describe('InboxTransportBridge', () => {
  it('emits one event per legacy JSONL row appended', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '1', channel: 'telegram:8075471258', senderId: '8075471258', text: 'hi' }),
    );
    await waitFor('received>=1', () => received.length >= 1);
    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.kind).toBe('inbound_message');
    expect(ev.sessionKey).toEqual({ platform: 'telegram', chatId: '8075471258' });
    expect(ev.messageId).toBe('1');
    expect(ev.sender).toEqual({ id: '8075471258', name: 'L0g1cProphet' });
    expect(ev.text).toBe('hi');
    expect(ev.projectUuid).toBe(TEST_PROJECT_UUID);
    expect(warnings).toEqual([]);
    // T-FLAKE-TRANSPORT-BRIDGE: the onEvent observability seam fires on the
    // happy path — the snapshot's event counters are live, not decorative.
    expect(events.add ?? 0).toBeGreaterThanOrEqual(1);
    expect(events.consume ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('emits three events in order for three rows appended in burst', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    const block =
      legacyRow({ id: 'a', channel: 'telegram:1', senderId: '1', text: 'one' }) +
      legacyRow({ id: 'b', channel: 'telegram:1', senderId: '1', text: 'two' }) +
      legacyRow({ id: 'c', channel: 'telegram:1', senderId: '1', text: 'three' });
    await fs.appendFile(inboxFile, block);
    await waitFor('received>=3', () => received.length >= 3);
    expect(received.map((r) => r.text)).toEqual(['one', 'two', 'three']);
    expect(warnings).toEqual([]);
  });

  it('warns on malformed JSON and continues with the next valid row', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      '{ not valid json\n' +
        legacyRow({ id: 'ok', channel: 'telegram:1', senderId: '1', text: 'after-bad' }),
    );
    await waitFor('received>=1', () => received.length >= 1);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('after-bad');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.includes('malformed JSON'))).toBe(true);
  });

  it('preserves topic thread_id into sessionKey.threadId', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({
        id: 't',
        channel: 'telegram:-1003923174632',
        senderId: '8075471258',
        text: 'topic msg',
        threadId: '15',
      }),
    );
    await waitFor('received>=1', () => received.length >= 1);
    expect(received[0]?.sessionKey).toEqual({
      platform: 'telegram',
      chatId: '-1003923174632',
      threadId: '15',
    });
  });

  it('consumes existing tail on startup (cursor=0 → emits backlog)', async () => {
    // Pre-write the backlog BEFORE starting the bridge.
    await fs.writeFile(
      inboxFile,
      legacyRow({ id: 'pre1', channel: 'telegram:1', senderId: '1', text: 'backlog-1' }) +
        legacyRow({ id: 'pre2', channel: 'telegram:1', senderId: '1', text: 'backlog-2' }),
    );
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await waitFor('received>=2', () => received.length >= 2);
    expect(received.map((r) => r.text)).toEqual(['backlog-1', 'backlog-2']);
  });

  it('cursor advances monotonically (no re-emission of consumed rows)', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '1', channel: 'telegram:1', senderId: '1', text: 'first' }),
    );
    await waitFor('received>=1', () => received.length >= 1);
    const cursorAfterFirst = bridge.cursorFor(inboxFile)!;
    expect(cursorAfterFirst).toBeGreaterThan(0);
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '2', channel: 'telegram:1', senderId: '1', text: 'second' }),
    );
    await waitFor('received>=2', () => received.length >= 2);
    const cursorAfterSecond = bridge.cursorFor(inboxFile)!;
    expect(cursorAfterSecond).toBeGreaterThan(cursorAfterFirst);
    expect(received.map((r) => r.text)).toEqual(['first', 'second']);
  });

  it('handles a partial trailing line (no newline) without emitting until completed', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    // Append a complete row + a partial trailer (no \n).
    const complete = legacyRow({
      id: 'full',
      channel: 'telegram:1',
      senderId: '1',
      text: 'whole',
    });
    const partial =
      '{"v":1,"id":"partial","platform":"telegram","channel":"telegram:1","sender":"L","sender_id":"1","text":"par';
    await fs.appendFile(inboxFile, complete + partial);
    await waitFor('received>=1', () => received.length >= 1);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('whole');
    // Now finish the partial.
    await fs.appendFile(
      inboxFile,
      'tial","received_at":"2026-05-21T19:00:00.000Z","enqueued_at":"2026-05-21T19:00:00.500Z","mentions_bot":false}\n',
    );
    await waitFor('received>=2', () => received.length >= 2);
    expect(received[1]?.text).toBe('partial');
    // Two waitFor cycles (double the IO latency) — give it explicit headroom
    // so it does not flake under full-suite parallel load (file-scope
    // vi.setConfig timeout is captured at it() registration, not here).
  }, 20_000);

  it('shutdown closes the watcher cleanly and stops further emits', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '1', channel: 'telegram:1', senderId: '1', text: 'pre-shutdown' }),
    );
    await waitFor('received>=1', () => received.length >= 1);
    await bridge.shutdown();
    const countAtShutdown = received.length;
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '2', channel: 'telegram:1', senderId: '1', text: 'post-shutdown' }),
    );
    // Give chokidar time to (not) deliver.
    await new Promise((r) => setTimeout(r, 250));
    expect(received.length).toBe(countAtShutdown);
    bridge = null; // afterEach should skip re-shutdown
  });

  it('skips rows with unsupported platform but does not crash', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    const badPlatform = JSON.stringify({
      v: 1,
      id: 'x',
      platform: 'sms',
      channel: 'sms:1',
      sender: 'a',
      sender_id: '1',
      text: 't',
      received_at: '2026-05-21T19:00:00.000Z',
      enqueued_at: '2026-05-21T19:00:00.500Z',
      mentions_bot: false,
    });
    await fs.appendFile(
      inboxFile,
      badPlatform +
        '\n' +
        legacyRow({ id: 'ok', channel: 'telegram:1', senderId: '1', text: 'after-bad' }),
    );
    await waitFor('received>=1', () => received.length >= 1);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('after-bad');
    expect(warnings.some((w) => w.includes("unsupported platform 'sms'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CAT.5 — umbrella-keyed transport. With `umbrellaId` set (and no inboxRoot
// override), the bridge watches `~/.opensquid/umbrellas/<id>/inbox/` and stamps
// `umbrellaId` onto every emitted event so the dispatcher arbitration reads the
// umbrella lease. We point OPENSQUID_HOME at the tmp dir so the path resolver
// lands inside the test sandbox.
// ---------------------------------------------------------------------------

describe('InboxTransportBridge — umbrella keyed (CAT.5)', () => {
  let priorHome: string | undefined;

  beforeEach(() => {
    priorHome = process.env.OPENSQUID_HOME;
    process.env.OPENSQUID_HOME = tmpRoot;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
  });

  it('watches the umbrella inbox dir + stamps umbrellaId onto events', async () => {
    const umbrellaId = 'loop';
    const umbInboxDir = path.join(tmpRoot, 'umbrellas', umbrellaId, 'inbox');
    await fs.mkdir(umbInboxDir, { recursive: true });
    const umbFile = path.join(umbInboxDir, 'telegram.jsonl');

    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      umbrellaId, // no inboxRoot → resolves to umbrellaInboxDir(umbrellaId)
      usePolling: true,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await fs.appendFile(
      umbFile,
      legacyRow({ id: '1', channel: 'telegram:8075471258', senderId: '8075471258', text: 'hi' }),
    );
    await waitFor('received>=1', () => received.length >= 1);
    expect(received).toHaveLength(1);
    expect(received[0]?.umbrellaId).toBe(umbrellaId);
    expect(received[0]?.text).toBe('hi');
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TBW.1 — ready-gated start + self-heal scan (the captured-flake regression
// pins; see T-fix-transport-bridge-watcher-race pre-research v2).
// ---------------------------------------------------------------------------

describe('TBW.1 — start() is ready-gated (both backends)', () => {
  for (const [label, polling] of [
    ['usePolling (the captured-flake config)', true],
    ['native backend (the prod daemon config)', false],
  ] as const) {
    it(`start() resolved => immediately-created file is received — ${label}`, async () => {
      bridge = new InboxTransportBridge({
        bus,
        projectUuid: TEST_PROJECT_UUID,
        inboxRoot: inboxDir,
        usePolling: polling,
        onWarn: (m) => warnings.push(m),
        onEvent: (k) => {
          events[k] = (events[k] ?? 0) + 1;
        },
      });
      await bridge.start();
      // The captured flake: file created + burst-appended right after start()
      // resolved produced ZERO events for 15s. The ready gate + self-heal
      // make this deterministic.
      await fs.appendFile(
        inboxFile,
        legacyRow({ id: 'r1', channel: 'telegram:1', senderId: '1', text: 'a' }) +
          legacyRow({ id: 'r2', channel: 'telegram:1', senderId: '1', text: 'b' }) +
          legacyRow({ id: 'r3', channel: 'telegram:1', senderId: '1', text: 'c' }),
      );
      await waitFor('received>=3 post-ready', () => received.length >= 3);
      expect(received.map((e) => e.messageId)).toEqual(['r1', 'r2', 'r3']);
    });
  }

  it('shutdown() during start() neither hangs nor throws', async () => {
    const b = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
    });
    const starting = b.start();
    await b.shutdown();
    await expect(starting).resolves.toBeUndefined();
    bridge = null; // already shut down
  });

  it('literal fileGlob: self-heal consumes only the matching file', async () => {
    await fs.writeFile(
      path.join(inboxDir, 'discord.jsonl'),
      legacyRow({ id: 'nope', channel: 'telegram:9', senderId: '9', text: 'x' }),
      'utf8',
    );
    await fs.writeFile(
      inboxFile,
      legacyRow({ id: 'yes', channel: 'telegram:1', senderId: '1', text: 'y' }),
      'utf8',
    );
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      fileGlob: 'telegram.jsonl',
      onWarn: (m) => warnings.push(m),
    });
    await bridge.start();
    await waitFor('received>=1 literal glob', () => received.length >= 1);
    expect(received.map((e) => e.messageId)).toEqual(['yes']);
  });
});

// ---------------------------------------------------------------------------
// TBR.1 — periodic self-heal reconcile (wg-4d2bc0929a32). The post-ready flake:
// a file created after start() resolved, whose chokidar `add` never fired,
// stayed undelivered forever (TBW.1's self-heal is one-shot at ready). The fix
// is a life-of-bridge reconcile interval. To PIN it (a chokidar-served test
// would pass even with the reconcile reverted) we inject a stub watcher that
// emits `ready` but never `add`/`change`, so the reconcile is the ONLY delivery
// path. No production branch — the seam is the injectable `watch` factory.
// ---------------------------------------------------------------------------

describe('TBR.1 — periodic reconcile delivers when watcher events are lost', () => {
  it('delivers a post-ready file via reconcile alone (watcher emits no add/change)', async () => {
    const stub = new EventEmitter();
    Object.assign(stub, { close: () => Promise.resolve(undefined) });
    const watchStub = ((): FSWatcher => {
      setImmediate(() => stub.emit('ready'));
      return stub as unknown as FSWatcher;
    }) as unknown as NonNullable<TransportBridgeOptions['watch']>;
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      rescanIntervalMs: 50,
      watch: watchStub,
      onWarn: (m) => warnings.push(m),
      onEvent: (k) => {
        events[k] = (events[k] ?? 0) + 1;
      },
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: 'r1', channel: 'telegram:1', senderId: '1', text: 'via-reconcile' }),
    );
    await waitFor('received via reconcile', () => received.length >= 1);
    expect(received[0]?.text).toBe('via-reconcile');
    // The stub never fires `add` — proves the reconcile timer delivered it.
    expect(events.add ?? 0).toBe(0);
  });
});

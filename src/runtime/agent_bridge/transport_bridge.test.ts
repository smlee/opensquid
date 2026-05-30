/**
 * agent_bridge — transport bridge unit tests (WAB.2).
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentEventBus } from './event_bus.js';
import { InboxTransportBridge } from './transport_bridge.js';
import type { InboundChatEvent } from './types.js';

const TEST_PROJECT_UUID = '00000000-0000-0000-0000-000000000001';

let tmpRoot: string;
let inboxDir: string;
let inboxFile: string;
let bus: AgentEventBus;
let received: InboundChatEvent[];
let warnings: string[];
let bridge: InboxTransportBridge | null;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opensquid-agent-bridge-test-'));
  inboxDir = path.join(tmpRoot, 'inbox');
  inboxFile = path.join(inboxDir, 'telegram.jsonl');
  await fs.mkdir(inboxDir, { recursive: true });
  bus = new AgentEventBus();
  received = [];
  warnings = [];
  bus.on('inbound', (e) => received.push(e));
  bridge = null;
});

afterEach(async () => {
  if (bridge) await bridge.shutdown();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Wait until either `pred()` returns truthy OR timeout. 5s default
 *  (was 2s) — Node 20 GitHub Actions runners + chokidar polling backend
 *  occasionally exceed 2s under shared-runner contention. Locally the
 *  predicate fires well under 500ms; the extra budget only matters in CI. */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout waiting for predicate');
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

describe('InboxTransportBridge', () => {
  it('emits one event per legacy JSONL row appended', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '1', channel: 'telegram:8075471258', senderId: '8075471258', text: 'hi' }),
    );
    await waitFor(() => received.length >= 1);
    expect(received).toHaveLength(1);
    const ev = received[0]!;
    expect(ev.kind).toBe('inbound_message');
    expect(ev.sessionKey).toEqual({ platform: 'telegram', chatId: '8075471258' });
    expect(ev.messageId).toBe('1');
    expect(ev.sender).toEqual({ id: '8075471258', name: 'L0g1cProphet' });
    expect(ev.text).toBe('hi');
    expect(ev.projectUuid).toBe(TEST_PROJECT_UUID);
    expect(warnings).toEqual([]);
  }, 20_000);

  it('emits three events in order for three rows appended in burst', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
    });
    await bridge.start();
    const block =
      legacyRow({ id: 'a', channel: 'telegram:1', senderId: '1', text: 'one' }) +
      legacyRow({ id: 'b', channel: 'telegram:1', senderId: '1', text: 'two' }) +
      legacyRow({ id: 'c', channel: 'telegram:1', senderId: '1', text: 'three' });
    await fs.appendFile(inboxFile, block);
    await waitFor(() => received.length >= 3);
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
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      '{ not valid json\n' +
        legacyRow({ id: 'ok', channel: 'telegram:1', senderId: '1', text: 'after-bad' }),
    );
    await waitFor(() => received.length >= 1);
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
    await waitFor(() => received.length >= 1);
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
    });
    await bridge.start();
    await waitFor(() => received.length >= 2);
    expect(received.map((r) => r.text)).toEqual(['backlog-1', 'backlog-2']);
  });

  it('cursor advances monotonically (no re-emission of consumed rows)', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '1', channel: 'telegram:1', senderId: '1', text: 'first' }),
    );
    await waitFor(() => received.length >= 1);
    const cursorAfterFirst = bridge.cursorFor(inboxFile)!;
    expect(cursorAfterFirst).toBeGreaterThan(0);
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '2', channel: 'telegram:1', senderId: '1', text: 'second' }),
    );
    await waitFor(() => received.length >= 2);
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
    await waitFor(() => received.length >= 1);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('whole');
    // Now finish the partial.
    await fs.appendFile(
      inboxFile,
      'tial","received_at":"2026-05-21T19:00:00.000Z","enqueued_at":"2026-05-21T19:00:00.500Z","mentions_bot":false}\n',
    );
    await waitFor(() => received.length >= 2);
    expect(received[1]?.text).toBe('partial');
  });

  it('shutdown closes the watcher cleanly and stops further emits', async () => {
    bridge = new InboxTransportBridge({
      bus,
      projectUuid: TEST_PROJECT_UUID,
      inboxRoot: inboxDir,
      usePolling: true,
      onWarn: (m) => warnings.push(m),
    });
    await bridge.start();
    await fs.appendFile(
      inboxFile,
      legacyRow({ id: '1', channel: 'telegram:1', senderId: '1', text: 'pre-shutdown' }),
    );
    await waitFor(() => received.length >= 1);
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
    await waitFor(() => received.length >= 1);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('after-bad');
    expect(warnings.some((w) => w.includes("unsupported platform 'sms'"))).toBe(true);
  });
});

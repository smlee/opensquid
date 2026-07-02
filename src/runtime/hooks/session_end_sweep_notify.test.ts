/**
 * RSW.2 — tests for the retention-sweep chat notification (Task #16).
 *
 * Three cases required by the task spec:
 *  1. swept.length > 0 + daemon reachable → sendChat called with the count.
 *  2. swept.length === 0 → no send, no error.
 *  3. daemon absent (ping → false) → no send, no throw; the stderr fallback
 *     in session-end.ts remains unaffected (it runs unconditionally before
 *     this call — verified by contract, not duplicated here).
 *
 * Pattern mirrors stop_stream.test.ts: inject channels config into an
 * isolated OPENSQUID_HOME, stub send/ping, assert call sites.
 */

import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelsConfigPath } from '../../channels/routing.js';
import type { DaemonSendParams, DaemonSendResult } from '../../chat_daemon/client.js';

import { notifyRetentionSweep } from './session_end_sweep_notify.js';

const CWD = '/x/loop';

const FAKE_RESULT: DaemonSendResult = {
  ok: true,
  platform: 'telegram',
  message_id: '42',
  delivered_at: 'now',
};

const reachablePing = (): Promise<boolean> => Promise.resolve(true);
const absentPing = (): Promise<boolean> => Promise.resolve(false);

function fakeSend(): { calls: DaemonSendParams[]; fn: (p: DaemonSendParams) => Promise<DaemonSendResult> } {
  const calls: DaemonSendParams[] = [];
  return {
    calls,
    fn: (p: DaemonSendParams) => {
      calls.push(p);
      return Promise.resolve(FAKE_RESULT);
    },
  };
}

describe('notifyRetentionSweep', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'rsw2-notify-'));
    process.env.OPENSQUID_HOME = home;
    await writeFile(
      channelsConfigPath(),
      JSON.stringify({
        v: 1,
        umbrellas: [{ id: 'loop', members: [CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    if (prev === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it('swept.length > 0 + daemon reachable → sendChat called with the count in the message', async () => {
    const { calls, fn } = fakeSend();

    await notifyRetentionSweep(['id1', 'id2', 'id3'], CWD, fn, reachablePing);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channel: 'telegram:-100',
      text: 'opensquid: memory retention sweep — 3 retired agent memories hard-deleted after 30 quiet days.',
      threadId: '15',
    });
  });

  it('swept.length === 0 → no send', async () => {
    const { calls, fn } = fakeSend();

    await notifyRetentionSweep([], CWD, fn, reachablePing);

    expect(calls).toHaveLength(0);
  });

  it('daemon absent (ping → false) → no send, no throw (stderr fallback in session-end.ts unaffected)', async () => {
    const { calls, fn } = fakeSend();

    // Must not throw even though swept.length > 0.
    await expect(notifyRetentionSweep(['id1'], CWD, fn, absentPing)).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
  });
});

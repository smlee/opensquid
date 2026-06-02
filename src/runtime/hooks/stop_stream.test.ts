/**
 * CAT.3 — tests for streaming a chat-driven turn's output back to source.
 *
 * maybeStreamOutput sends the assistant's text to the umbrella's outbound
 * Telegram target ONLY when the chat-driven marker matches this session, then
 * consumes the marker. Terminal turns (no marker) don't stream.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { channelsConfigPath } from '../../channels/routing.js';
import type { DaemonSendParams } from '../agent_bridge/tools/chat_send.js';
import { umbrellaChatDrivenMarker } from '../paths.js';

import { markChatDriven, maybeStreamOutput } from './stop_stream.js';

const SESSION = 'sess-holder';
const CWD = '/x/loop';

function fakeSend(): {
  fn: (
    p: DaemonSendParams,
  ) => Promise<{ ok: boolean; platform: string; message_id: string; delivered_at: string }>;
  calls: DaemonSendParams[];
} {
  const calls: DaemonSendParams[] = [];
  return {
    calls,
    fn: vi.fn((p: DaemonSendParams) => {
      calls.push(p);
      return Promise.resolve({
        ok: true,
        platform: 'telegram',
        message_id: '99',
        delivered_at: 'now',
      });
    }),
  };
}

describe('maybeStreamOutput', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cat3-'));
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

  it('streams to the source topic + consumes the marker when it matches this session', async () => {
    await markChatDriven('loop', SESSION);
    const send = fakeSend();
    const sent = await maybeStreamOutput(SESSION, CWD, 'here is my answer', send.fn);
    expect(sent).toBe(true);
    expect(send.calls).toEqual([
      { channel: 'telegram:-100', text: 'here is my answer', threadId: '15' },
    ]);
    // Marker consumed → a second call is a no-op.
    expect(await maybeStreamOutput(SESSION, CWD, 'again', send.fn)).toBe(false);
  });

  it('does NOT stream a terminal turn (no marker)', async () => {
    const send = fakeSend();
    expect(await maybeStreamOutput(SESSION, CWD, 'terminal answer', send.fn)).toBe(false);
    expect(send.calls).toHaveLength(0);
  });

  it('does NOT stream when the marker belongs to another session (and keeps it)', async () => {
    await markChatDriven('loop', 'someone-else');
    const send = fakeSend();
    expect(await maybeStreamOutput(SESSION, CWD, 'answer', send.fn)).toBe(false);
    expect(send.calls).toHaveLength(0);
    // The other session's marker is untouched.
    const marker = await import('node:fs/promises').then((m) =>
      m.readFile(umbrellaChatDrivenMarker('loop'), 'utf8'),
    );
    expect(marker).toBe('someone-else');
  });

  it('does NOT stream empty assistant text', async () => {
    await markChatDriven('loop', SESSION);
    const send = fakeSend();
    expect(await maybeStreamOutput(SESSION, CWD, '   ', send.fn)).toBe(false);
    expect(send.calls).toHaveLength(0);
  });

  it('does NOT stream when cwd resolves to no umbrella', async () => {
    await markChatDriven('loop', SESSION);
    const send = fakeSend();
    expect(await maybeStreamOutput(SESSION, '/elsewhere', 'answer', send.fn)).toBe(false);
    expect(send.calls).toHaveLength(0);
  });
});

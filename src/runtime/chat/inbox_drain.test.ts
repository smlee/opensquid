/**
 * CAT.2 — tests for the shared umbrella-inbox drain. Verifies the
 * ack-before-return semantics (a drained message is not re-drained) and
 * umbrella resolution (cwd → umbrella via channels.json), fail-open.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelsConfigPath } from '../../channels/routing.js';
import { umbrellaInboxDir, umbrellaInboxFile } from '../paths.js';

import { drainUmbrellaInbox } from './inbox_drain.js';

const SESSION = 'sess-cat2';
const CWD = '/x/loop';

function inboxRow(id: string, text: string): string {
  return (
    JSON.stringify({
      v: 1,
      id,
      thread_id: '15',
      platform: 'telegram',
      channel: 'telegram:-100',
      sender: 'L0g1cProphet',
      sender_id: '807',
      text,
      received_at: '2026-06-02T05:00:00.000Z',
      enqueued_at: '2026-06-02T05:00:00.100Z',
      mentions_bot: false,
    }) + '\n'
  );
}

describe('drainUmbrellaInbox', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cat2-drain-'));
    process.env.OPENSQUID_HOME = home;
    await writeFile(
      channelsConfigPath(),
      JSON.stringify({
        v: 1,
        umbrellas: [{ id: 'loop', members: [CWD], telegram: { chat_id: '-100', topic_id: 15 } }],
      }),
      'utf8',
    );
    await mkdir(umbrellaInboxDir('loop'), { recursive: true });
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it('returns an envelope for unacked inbound + acks it (second call is empty)', async () => {
    await writeFile(
      umbrellaInboxFile('loop', 'telegram'),
      inboxRow('1', 'hello from phone'),
      'utf8',
    );
    const first = await drainUmbrellaInbox(SESSION, CWD);
    expect(first).toContain('hello from phone');
    // Ack-before-return ⇒ the same message is not re-drained.
    const second = await drainUmbrellaInbox(SESSION, CWD);
    expect(second).toBe('');
  });

  it('drains only the new message on a later call (incremental)', async () => {
    await writeFile(umbrellaInboxFile('loop', 'telegram'), inboxRow('1', 'first'), 'utf8');
    expect(await drainUmbrellaInbox(SESSION, CWD)).toContain('first');
    await writeFile(
      umbrellaInboxFile('loop', 'telegram'),
      inboxRow('1', 'first') + inboxRow('2', 'second'),
      'utf8',
    );
    const out = await drainUmbrellaInbox(SESSION, CWD);
    expect(out).toContain('second');
    expect(out).not.toContain('first');
  });

  it('returns empty when cwd resolves to no umbrella', async () => {
    await writeFile(umbrellaInboxFile('loop', 'telegram'), inboxRow('1', 'x'), 'utf8');
    expect(await drainUmbrellaInbox(SESSION, '/somewhere/else')).toBe('');
  });

  it('returns empty when channels.json is absent (fail-open)', async () => {
    await rm(channelsConfigPath(), { force: true });
    expect(await drainUmbrellaInbox(SESSION, CWD)).toBe('');
  });
});

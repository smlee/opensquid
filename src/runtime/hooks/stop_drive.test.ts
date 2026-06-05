/**
 * CAT.2 — tests for the Stop-hook inbound drive (lease gate + ack semantics).
 *
 * maybeDriveInbound returns the block reason ONLY when this session holds the
 * umbrella's chat lease and has unacked inbound; the drain acks-before-return
 * so it never re-drives.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { channelsConfigPath } from '../../channels/routing.js';
import { umbrellaInboxDir, umbrellaInboxFile, umbrellaLiveSessionLease } from '../paths.js';

import { extractCwd, maybeDriveInbound, maybePeekInbound } from './stop_drive.js';

const SESSION = 'sess-holder';
const CWD = '/x/loop';

const row = (id: string, text: string): string =>
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
  }) + '\n';

async function writeLease(umbrellaId: string, sessionId: string): Promise<void> {
  await writeFile(
    umbrellaLiveSessionLease(umbrellaId),
    JSON.stringify({
      session_id: sessionId,
      pid: process.pid,
      refreshed_at: new Date().toISOString(),
    }),
    'utf8',
  );
}

describe('maybeDriveInbound', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cat2-drive-'));
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
    await writeFile(umbrellaInboxFile('loop', 'telegram'), row('1', 'drive me'), 'utf8');
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it('drives when this session holds the lease + has unacked inbound', async () => {
    await writeLease('loop', SESSION);
    const reason = await maybeDriveInbound(SESSION, CWD);
    expect(reason).not.toBeNull();
    expect(reason).toContain('drive me');
  });

  it('does NOT drive a session that is not the lease holder (invariant #6)', async () => {
    await writeLease('loop', SESSION); // someone else holds it
    expect(await maybeDriveInbound('a-different-session', CWD)).toBeNull();
  });

  it('does NOT drive when no lease is held', async () => {
    // no lease written
    expect(await maybeDriveInbound(SESSION, CWD)).toBeNull();
  });

  it('does not re-drive an already-driven message (ack-before-return)', async () => {
    await writeLease('loop', SESSION);
    expect(await maybeDriveInbound(SESSION, CWD)).toContain('drive me');
    expect(await maybeDriveInbound(SESSION, CWD)).toBeNull();
  });

  it('does not drive when cwd resolves to no umbrella', async () => {
    await writeLease('loop', SESSION);
    expect(await maybeDriveInbound(SESSION, '/elsewhere')).toBeNull();
  });
});

describe('maybePeekInbound (read-only surface, SF.2)', () => {
  let home: string;
  const prev = process.env.OPENSQUID_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'sf2-peek-'));
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
    await writeFile(umbrellaInboxFile('loop', 'telegram'), row('1', 'see me'), 'utf8');
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prev;
    await rm(home, { recursive: true, force: true });
  });

  it('surfaces inbound for the lease holder WITHOUT acking (re-surfaces on a second call)', async () => {
    await writeLease('loop', SESSION);
    expect(await maybePeekInbound(SESSION, CWD)).toContain('see me');
    // Read-only: NOT acked ⇒ still surfaced again (and still drivable later).
    expect(await maybePeekInbound(SESSION, CWD)).toContain('see me');
  });

  it('does NOT surface for a non-lease session (invariant #6)', async () => {
    await writeLease('loop', SESSION);
    expect(await maybePeekInbound('a-different-session', CWD)).toBeNull();
  });

  it('peek does not consume — a later drive still delivers + acks the message', async () => {
    await writeLease('loop', SESSION);
    expect(await maybePeekInbound(SESSION, CWD)).toContain('see me');
    expect(await maybeDriveInbound(SESSION, CWD)).toContain('see me'); // drive still finds it
    expect(await maybeDriveInbound(SESSION, CWD)).toBeNull(); // now acked
  });
});

describe('extractCwd', () => {
  it('reads cwd from the Stop payload', () => {
    expect(extractCwd(JSON.stringify({ cwd: '/a/b' }))).toBe('/a/b');
  });
  it('falls back to process.cwd() on missing/invalid', () => {
    expect(extractCwd('{}')).toBe(process.cwd());
    expect(extractCwd('not json')).toBe(process.cwd());
  });
});

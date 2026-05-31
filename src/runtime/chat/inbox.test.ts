/**
 * LL.1 — unit tests for the InboxRow / AckRow Zod schemas + readers.
 *
 * Schemas:
 *   - InboxRow: byte-for-byte compat with the daemon-written shape
 *     (v:1 + id + thread_id? + platform + channel + sender + sender_id +
 *     text + received_at + enqueued_at + mentions_bot, .strict())
 *   - AckRow: v:1 + message_id + platform + injected_at_sessionId +
 *     injected_at_timestamp, .strict()
 *
 * Readers: readInbox + readAcked are best-effort silent-skip on parse
 * failure. ENOENT → empty array.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AckRow, InboxRow, ackKey, readAcked, readInbox } from './inbox.js';

let tempHome: string;
let priorHome: string | undefined;
const PROJECT_UUID = 'uuid-x';

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-ll1-inbox-'));
  process.env.OPENSQUID_HOME = tempHome;
  await mkdir(join(tempHome, 'projects', PROJECT_UUID, 'inbox'), { recursive: true });
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('InboxRow schema', () => {
  const valid = (over: Record<string, unknown> = {}): unknown => ({
    v: 1,
    id: '42',
    platform: 'telegram',
    channel: '-100123',
    sender: 'alice',
    sender_id: 'u1',
    text: 'hi',
    received_at: '2026-05-30T12:00:00Z',
    enqueued_at: '2026-05-30T12:00:00.123Z',
    mentions_bot: false,
    ...over,
  });

  it('valid InboxRow parses', () => {
    const r = InboxRow.parse(valid());
    expect(r.id).toBe('42');
    expect(r.platform).toBe('telegram');
  });

  it('InboxRow with v: 2 rejected (literal mismatch)', () => {
    expect(InboxRow.safeParse(valid({ v: 2 })).success).toBe(false);
  });

  it('InboxRow missing text rejected', () => {
    const obj = valid() as Record<string, unknown>;
    delete obj.text;
    expect(InboxRow.safeParse(obj).success).toBe(false);
  });

  it('InboxRow with extra key rejected (.strict())', () => {
    expect(InboxRow.safeParse(valid({ foo: 'bar' })).success).toBe(false);
  });

  it('InboxRow with platform: "irc" rejected (enum)', () => {
    expect(InboxRow.safeParse(valid({ platform: 'irc' })).success).toBe(false);
  });

  it('InboxRow with thread_id present parses', () => {
    const r = InboxRow.parse(valid({ thread_id: '281' }));
    expect(r.thread_id).toBe('281');
  });
});

describe('AckRow schema', () => {
  const valid = (over: Record<string, unknown> = {}): unknown => ({
    v: 1,
    message_id: '42',
    platform: 'telegram',
    injected_at_sessionId: 'sess-A',
    injected_at_timestamp: '2026-05-30T12:01:00Z',
    ...over,
  });

  it('valid AckRow parses', () => {
    const r = AckRow.parse(valid());
    expect(r.message_id).toBe('42');
  });

  it('AckRow with platform: "irc" rejected (enum)', () => {
    expect(AckRow.safeParse(valid({ platform: 'irc' })).success).toBe(false);
  });

  it('AckRow with extra key rejected (.strict())', () => {
    expect(AckRow.safeParse(valid({ extra: 'x' })).success).toBe(false);
  });
});

describe('readInbox / readAcked best-effort readers', () => {
  it('readInbox against absent file → []', async () => {
    const rows = await readInbox(PROJECT_UUID, 'discord');
    expect(rows).toEqual([]);
  });

  it('readInbox with 3 valid + 1 malformed-tail line → 3 valid rows', async () => {
    const valid1 =
      '{"v":1,"id":"1","platform":"telegram","channel":"c","sender":"s","sender_id":"u","text":"hi1","received_at":"r","enqueued_at":"e","mentions_bot":false}';
    const valid2 =
      '{"v":1,"id":"2","platform":"telegram","channel":"c","sender":"s","sender_id":"u","text":"hi2","received_at":"r","enqueued_at":"e","mentions_bot":false}';
    const valid3 =
      '{"v":1,"id":"3","platform":"telegram","channel":"c","sender":"s","sender_id":"u","text":"hi3","received_at":"r","enqueued_at":"e","mentions_bot":false}';
    const partial = '{"v":1,"id":"4","plat'; // truncated tail
    await writeFile(
      join(tempHome, 'projects', PROJECT_UUID, 'inbox', 'telegram.jsonl'),
      [valid1, valid2, valid3, partial].join('\n') + '\n',
      'utf8',
    );
    const rows = await readInbox(PROJECT_UUID, 'telegram');
    expect(rows.map((r) => r.id)).toEqual(['1', '2', '3']);
  });

  it('readAcked against file with 2 valid AckRows → returns both', async () => {
    const r1 =
      '{"v":1,"message_id":"1","platform":"telegram","injected_at_sessionId":"s1","injected_at_timestamp":"t1"}';
    const r2 =
      '{"v":1,"message_id":"2","platform":"discord","injected_at_sessionId":"s2","injected_at_timestamp":"t2"}';
    await writeFile(
      join(tempHome, 'projects', PROJECT_UUID, 'inbox', 'acked.jsonl'),
      [r1, r2].join('\n') + '\n',
      'utf8',
    );
    const rows = await readAcked(PROJECT_UUID);
    expect(rows.map((r) => r.message_id)).toEqual(['1', '2']);
  });

  it('readAcked skips invalid v:2 rows', async () => {
    const r1 =
      '{"v":1,"message_id":"1","platform":"telegram","injected_at_sessionId":"s1","injected_at_timestamp":"t1"}';
    const r2 =
      '{"v":2,"message_id":"2","platform":"telegram","injected_at_sessionId":"s2","injected_at_timestamp":"t2"}';
    await writeFile(
      join(tempHome, 'projects', PROJECT_UUID, 'inbox', 'acked.jsonl'),
      [r1, r2].join('\n') + '\n',
      'utf8',
    );
    const rows = await readAcked(PROJECT_UUID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message_id).toBe('1');
  });
});

describe('ackKey canonical dedup string (LL4FIX.1 — 2-arg)', () => {
  it("returns 'telegram::42' for (platform, messageId)", () => {
    expect(ackKey('telegram', '42')).toBe('telegram::42');
  });
  it('different platforms produce different keys for the same id', () => {
    expect(ackKey('telegram', '42')).not.toBe(ackKey('slack', '42'));
  });
});

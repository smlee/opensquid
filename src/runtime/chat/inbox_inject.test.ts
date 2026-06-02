/**
 * LL.4 — unit tests for pure inbox-inject helpers.
 *
 * No I/O; AckRow + InboxRow literals constructed inline.
 */
import { describe, expect, it } from 'vitest';

import type { AckRow, InboxRow } from './inbox.js';
import {
  buildAckRowsForInjected,
  buildInjectionEnvelope,
  computeUnackedRows,
  purgeOldAcks,
} from './inbox_inject.js';

function inboxRow(over: Partial<InboxRow> & { id: string; received_at: string }): InboxRow {
  return {
    v: 1,
    platform: 'telegram',
    channel: '-100123',
    sender: 'alice',
    sender_id: 'u1',
    text: 'hi',
    enqueued_at: over.received_at,
    mentions_bot: false,
    ...over,
  };
}

function ackRow(over: Partial<AckRow> & { message_id: string }): AckRow {
  return {
    v: 1,
    platform: 'telegram',
    injected_at_sessionId: 'sess-A',
    injected_at_timestamp: '2026-05-30T12:00:00Z',
    ...over,
  };
}

describe('computeUnackedRows — cross-session dedup (LL4FIX.1)', () => {
  it('1 row + empty acked + sessionId sess-A → unacked = [row]', () => {
    const rows = [inboxRow({ id: '1', received_at: '2026-05-30T12:00:00Z' })];
    expect(computeUnackedRows(rows, [], 'sess-A').map((r) => r.id)).toEqual(['1']);
  });

  it('1 row + matching AckRow for SAME sessionId → unacked = []', () => {
    const rows = [inboxRow({ id: '1', received_at: '2026-05-30T12:00:00Z' })];
    const acked = [ackRow({ message_id: '1', injected_at_sessionId: 'sess-A' })];
    expect(computeUnackedRows(rows, acked, 'sess-A')).toEqual([]);
  });

  // LL4FIX.1 STRENGTHENED CONTRACT: an ack from session A dedupes for session B.
  // Previously this returned [row] (per-session re-flood); the new contract
  // returns [] because dedup key is (platform, message_id) only.
  it('1 row + AckRow for DIFFERENT sessionId → unacked = [] (cross-session dedup)', () => {
    const rows = [inboxRow({ id: '1', received_at: '2026-05-30T12:00:00Z' })];
    const acked = [ackRow({ message_id: '1', injected_at_sessionId: 'sess-OTHER' })];
    expect(computeUnackedRows(rows, acked, 'sess-A')).toEqual([]);
  });

  it('per-platform isolation preserved: telegram ack does not dedupe slack row with same id', () => {
    const rows = [
      inboxRow({
        id: '42',
        platform: 'slack',
        received_at: '2026-05-30T12:00:00Z',
      }),
    ];
    const acked = [
      ackRow({ message_id: '42', platform: 'telegram', injected_at_sessionId: 'sess-A' }),
    ];
    expect(computeUnackedRows(rows, acked, 'sess-A').map((r) => r.id)).toEqual(['42']);
  });

  it('5 rows + 2 already acked → unacked = 3 sorted by received_at', () => {
    const rows = [
      inboxRow({ id: '3', received_at: '2026-05-30T12:00:03Z' }),
      inboxRow({ id: '1', received_at: '2026-05-30T12:00:01Z' }),
      inboxRow({ id: '4', received_at: '2026-05-30T12:00:04Z' }),
      inboxRow({ id: '5', received_at: '2026-05-30T12:00:05Z' }),
      inboxRow({ id: '2', received_at: '2026-05-30T12:00:02Z' }),
    ];
    const acked = [
      ackRow({ message_id: '1', injected_at_sessionId: 'sess-A' }),
      ackRow({ message_id: '3', injected_at_sessionId: 'sess-A' }),
    ];
    expect(computeUnackedRows(rows, acked, 'sess-A').map((r) => r.id)).toEqual(['2', '4', '5']);
  });
});

describe('buildInjectionEnvelope — header + per-row format + 8KB budget', () => {
  it('empty rows → empty envelope, zero injectedRows', () => {
    expect(buildInjectionEnvelope([])).toEqual({ envelope: '', injectedRows: [] });
  });

  it('1 row → "📨 Inbound messages (1)" header + per-row line', () => {
    const rows = [inboxRow({ id: '1', received_at: '2026-05-30T12:00:00Z' })];
    const { envelope, injectedRows } = buildInjectionEnvelope(rows);
    expect(envelope).toBe('📨 Inbound messages (1)\nalice (telegram): hi');
    expect(injectedRows.map((r) => r.id)).toEqual(['1']);
  });

  it('3 mixed-platform rows → 3 lines in input order', () => {
    const rows = [
      inboxRow({ id: '1', received_at: '2026-05-30T12:00:01Z', sender: 'alice' }),
      inboxRow({
        id: '2',
        received_at: '2026-05-30T12:00:02Z',
        sender: 'bob',
        platform: 'slack',
      }),
      inboxRow({
        id: '3',
        received_at: '2026-05-30T12:00:03Z',
        sender: 'carol',
        platform: 'discord',
      }),
    ];
    const { envelope, injectedRows } = buildInjectionEnvelope(rows);
    expect(envelope).toContain('📨 Inbound messages (3)');
    expect(envelope).toContain('alice (telegram): hi');
    expect(envelope).toContain('bob (slack): hi');
    expect(envelope).toContain('carol (discord): hi');
    expect(injectedRows).toHaveLength(3);
  });

  // CAT.4 — a row carrying media gets a Read-pointer line per attachment.
  it('emits a 📎 Read-pointer line per media item under the text line', () => {
    const rows = [
      inboxRow({
        id: '1',
        received_at: '2026-05-30T12:00:00Z',
        text: 'see attached',
        media: [
          { kind: 'photo', path: '/tmp/a.jpg', caption: 'see attached' },
          { kind: 'document', path: '/tmp/b.pdf' },
        ],
      }),
    ];
    const { envelope, injectedRows } = buildInjectionEnvelope(rows);
    expect(envelope).toBe(
      '📨 Inbound messages (1)\n' +
        'alice (telegram): see attached\n' +
        '📎 photo: /tmp/a.jpg — Read this file to view\n' +
        '📎 document: /tmp/b.pdf — Read this file to view',
    );
    expect(injectedRows.map((r) => r.id)).toEqual(['1']);
  });

  it('overflow >8KB → injects only what fits; remaining rows stay unacked', () => {
    const bigText = 'x'.repeat(4000);
    const rows = [
      inboxRow({ id: '1', received_at: '2026-05-30T12:00:01Z', text: bigText }),
      inboxRow({ id: '2', received_at: '2026-05-30T12:00:02Z', text: bigText }),
      inboxRow({ id: '3', received_at: '2026-05-30T12:00:03Z', text: bigText }),
    ];
    const { envelope, injectedRows } = buildInjectionEnvelope(rows);
    expect(injectedRows.length).toBeLessThan(3);
    expect(injectedRows.length).toBeGreaterThanOrEqual(1);
    expect(envelope).toContain(`📨 Inbound messages (${String(injectedRows.length)})`);
  });
});

describe('purgeOldAcks — 7-day cutoff', () => {
  it('drops rows older than 7 days', () => {
    const now = new Date('2026-05-30T12:00:00Z');
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const acked = [
      ackRow({ message_id: 'old', injected_at_timestamp: eightDaysAgo }),
      ackRow({ message_id: 'recent', injected_at_timestamp: oneDayAgo }),
    ];
    expect(purgeOldAcks(acked, now).map((a) => a.message_id)).toEqual(['recent']);
  });

  it('keeps all rows when none older than 7 days', () => {
    const now = new Date('2026-05-30T12:00:00Z');
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const acked = [
      ackRow({ message_id: 'a', injected_at_timestamp: oneDayAgo }),
      ackRow({ message_id: 'b', injected_at_timestamp: oneDayAgo }),
    ];
    expect(purgeOldAcks(acked, now)).toHaveLength(2);
  });

  it('drops malformed timestamps (Date.parse returns NaN)', () => {
    const acked = [ackRow({ message_id: 'bad', injected_at_timestamp: 'not-a-date' })];
    expect(purgeOldAcks(acked, new Date())).toEqual([]);
  });
});

describe('buildAckRowsForInjected', () => {
  it('maps each injected row to an AckRow with sessionId + now', () => {
    const rows = [inboxRow({ id: '1', received_at: '2026-05-30T12:00:00Z' })];
    const now = new Date('2026-05-30T12:00:05Z');
    const acks = buildAckRowsForInjected(rows, 'sess-A', now);
    expect(acks).toEqual([
      {
        v: 1,
        message_id: '1',
        platform: 'telegram',
        injected_at_sessionId: 'sess-A',
        injected_at_timestamp: '2026-05-30T12:00:05.000Z',
      },
    ]);
  });
});

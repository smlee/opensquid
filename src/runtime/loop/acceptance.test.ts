/**
 * T2.8 — acceptance.ts tests (deterministic, zero LLM). Uses the vitest globalSetup OPENSQUID_HOME temp dir
 * (sessionStateFile writes under it); each test uses a UNIQUE session id so the durable jsonl never collides.
 */
import { describe, expect, it } from 'vitest';

import {
  appendAcceptance,
  markAccepted,
  readAcceptance,
  waitingItems,
  type AcceptanceItem,
} from './acceptance.js';

const ISO = '2026-06-26T00:00:00.000Z';
const ISO2 = '2026-06-26T01:00:00.000Z';

const item = (over: Partial<AcceptanceItem> = {}): AcceptanceItem => ({
  id: 'a1',
  taskId: 'T2.8',
  status: 'waiting',
  addedAt: ISO,
  ...over,
});

describe('acceptance (T2.8)', () => {
  it('append → read round-trips the item', async () => {
    const sid = 'sess-accept-rt';
    await appendAcceptance(sid, item());
    const read = await readAcceptance(sid);
    expect(read).toEqual([item()]);
  });

  it('a missing file reads as empty (no throw)', async () => {
    expect(await readAcceptance('sess-accept-empty-xyz')).toEqual([]);
  });

  it('collapses by id LAST-WRITER-WINS', async () => {
    const sid = 'sess-accept-lww';
    await appendAcceptance(sid, item({ status: 'waiting' }));
    await appendAcceptance(sid, item({ status: 'accepted', addedAt: ISO2 }));
    const read = await readAcceptance(sid);
    expect(read).toHaveLength(1);
    expect(read[0]?.status).toBe('accepted');
    expect(read[0]?.addedAt).toBe(ISO2); // the later writer won
  });

  it('two distinct ids both survive', async () => {
    const sid = 'sess-accept-two';
    await appendAcceptance(sid, item({ id: 'a1', taskId: 'T-a' }));
    await appendAcceptance(sid, item({ id: 'a2', taskId: 'T-b' }));
    const read = await readAcceptance(sid);
    expect(read.map((i) => i.id).sort()).toEqual(['a1', 'a2']);
  });

  it('markAccepted appends an accepted record (iso passed in, no Date.now)', async () => {
    const sid = 'sess-accept-mark';
    await appendAcceptance(sid, item());
    await markAccepted(sid, 'a1', ISO2);
    const read = await readAcceptance(sid);
    expect(read).toHaveLength(1);
    expect(read[0]?.status).toBe('accepted');
    expect(read[0]?.addedAt).toBe(ISO2);
    expect(read[0]?.taskId).toBe('T2.8'); // carried from the original
  });

  it('markAccepted on an unknown id is a no-op (no record materialized)', async () => {
    const sid = 'sess-accept-mark-missing';
    await markAccepted(sid, 'ghost', ISO2);
    expect(await readAcceptance(sid)).toEqual([]);
  });

  it('waitingItems returns only the waiting items', async () => {
    const sid = 'sess-accept-waiting';
    await appendAcceptance(sid, item({ id: 'w', taskId: 'T-w', status: 'waiting' }));
    await appendAcceptance(sid, item({ id: 'd', taskId: 'T-d', status: 'accepted' }));
    const waiting = await waitingItems(sid);
    expect(waiting.map((i) => i.taskId)).toEqual(['T-w']);
  });

  it('DURABLE: a waiting item survives a fresh read (append-only jsonl, no in-memory state)', async () => {
    const sid = 'sess-accept-durable';
    await appendAcceptance(sid, item({ taskId: 'T-durable' }));
    // a SECOND, independent read (no shared handle) — proves the item persisted to disk, not memory.
    const reread = await waitingItems(sid);
    expect(reread.map((i) => i.taskId)).toEqual(['T-durable']);
  });

  it('a marked-accepted item is NO LONGER waiting (durable transition)', async () => {
    const sid = 'sess-accept-durable-mark';
    await appendAcceptance(sid, item());
    expect((await waitingItems(sid)).map((i) => i.id)).toEqual(['a1']);
    await markAccepted(sid, 'a1', ISO2);
    expect(await waitingItems(sid)).toEqual([]); // collapsed to accepted via last-writer-wins
  });
});

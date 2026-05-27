/**
 * Tests for the `chat watch` inbox tail core (Track T-TR, TR.1).
 *
 * Coverage per spec test fixtures:
 *   - backlog skipped: pre-existing rows are NOT emitted; only post-start appends
 *   - happy: appended row → one formatted line
 *   - partial trailing line carried across two writes → one emitted line
 *   - malformed JSON line skipped (warned), watcher stays alive
 *   - truncation/rotation (size < cursor) resets cursor, later appends still emit
 *   - file not existing at start → first creation streams correctly
 *   - mentionsOnly filters non-mention rows
 *   - formatRow: thread fallback for DMs (no thread_id)
 *
 * `usePolling: true` makes chokidar deterministic in CI (mirrors the
 * transport_bridge test seam). awaitWriteFinish adds ~50-150ms latency per
 * event, so `until()` polls with a generous ceiling.
 */

import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatRow, watchInbox, type InboxRow } from './watch.js';

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 'm1',
    thread_id: '42',
    platform: 'telegram',
    channel: 'chan',
    sender: 'alice',
    sender_id: 's1',
    text: 'hello',
    received_at: '2026-05-27T00:00:00Z',
    enqueued_at: '2026-05-27T00:00:00Z',
    mentions_bot: false,
    ...over,
  };
}
const jline = (r: InboxRow): string => JSON.stringify(r) + '\n';

async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

let dir: string;
let inbox: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chat-watch-'));
  inbox = join(dir, 'telegram.jsonl');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Start the watcher (fire-and-forget) + return the out array, warns, and a stop(). */
function startWatch(over: Partial<Parameters<typeof watchInbox>[0]> = {}): {
  out: string[];
  warns: string[];
  stop: () => Promise<void>;
} {
  const out: string[] = [];
  const warns: string[] = [];
  const ac = new AbortController();
  const done = watchInbox({
    inboxFile: inbox,
    mentionsOnly: false,
    format: formatRow,
    out: (l) => out.push(l),
    onWarn: (m) => warns.push(m),
    usePolling: true,
    signal: ac.signal,
    ...over,
  });
  return {
    out,
    warns,
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

describe('watchInbox', () => {
  it('skips the backlog and emits only post-start appends', async () => {
    await writeFile(inbox, jline(row({ text: 'old-1' })) + jline(row({ text: 'old-2' })));
    const w = startWatch();
    await settle();
    await appendFile(inbox, jline(row({ text: 'new' })));
    await until(() => w.out.length === 1);
    expect(w.out).toEqual(['[tg 42] alice: new']);
    await w.stop();
  });

  it('emits a formatted line for an appended row', async () => {
    await writeFile(inbox, '');
    const w = startWatch();
    await settle();
    await appendFile(inbox, jline(row({ sender: 'bob', text: 'hi there' })));
    await until(() => w.out.length === 1);
    expect(w.out[0]).toBe('[tg 42] bob: hi there');
    await w.stop();
  });

  it('emits raw JSONL when format passes through', async () => {
    await writeFile(inbox, '');
    const r = row({ text: 'raw me' });
    const w = startWatch({ format: (x) => JSON.stringify(x) });
    await settle();
    await appendFile(inbox, jline(r));
    await until(() => w.out.length === 1);
    expect(JSON.parse(String(w.out[0])) as InboxRow).toEqual(r);
    await w.stop();
  });

  it('carries a partial trailing line across writes (one emission)', async () => {
    await writeFile(inbox, '');
    const full = jline(row({ text: 'abcd' }));
    const cut = Math.floor(full.length / 2);
    const w = startWatch();
    await settle();
    await appendFile(inbox, full.slice(0, cut)); // no newline yet
    await settle();
    expect(w.out).toEqual([]); // incomplete line not emitted
    await appendFile(inbox, full.slice(cut)); // completes the line + newline
    await until(() => w.out.length === 1);
    expect(w.out[0]).toBe('[tg 42] alice: abcd');
    await w.stop();
  });

  it('skips a malformed line without tearing down the watcher', async () => {
    await writeFile(inbox, '');
    const w = startWatch();
    await settle();
    await appendFile(inbox, 'not json at all\n');
    await appendFile(inbox, jline(row({ text: 'valid' })));
    await until(() => w.out.length === 1);
    expect(w.out).toEqual(['[tg 42] alice: valid']);
    expect(w.warns.some((m) => m.includes('malformed'))).toBe(true);
    await w.stop();
  });

  it('resets the cursor on truncation and still emits later appends', async () => {
    await writeFile(inbox, '');
    const w = startWatch();
    await settle();
    await appendFile(inbox, jline(row({ text: 'before' })));
    await until(() => w.out.length === 1);
    await truncate(inbox, 0); // size < cursor
    await settle();
    await appendFile(inbox, jline(row({ text: 'after' })));
    await until(() => w.out.length === 2);
    expect(w.out).toEqual(['[tg 42] alice: before', '[tg 42] alice: after']);
    await w.stop();
  });

  it('streams a file that does not exist at start once it is created', async () => {
    const w = startWatch(); // inbox does not exist yet
    await settle();
    await writeFile(inbox, jline(row({ text: 'first ever' })));
    await until(() => w.out.length === 1);
    expect(w.out[0]).toBe('[tg 42] alice: first ever');
    await w.stop();
  });

  it('emits only mention rows when mentionsOnly is set', async () => {
    await writeFile(inbox, '');
    const w = startWatch({ mentionsOnly: true });
    await settle();
    await appendFile(inbox, jline(row({ text: 'ignored', mentions_bot: false })));
    await appendFile(inbox, jline(row({ text: 'kept', mentions_bot: true })));
    await until(() => w.out.length === 1);
    expect(w.out).toEqual(['[tg 42] alice: kept']);
    await w.stop();
  });
});

describe('formatRow', () => {
  it('formats telegram with a thread id', () => {
    expect(formatRow(row({ thread_id: '7', sender: 'x', text: 'y' }))).toBe('[tg 7] x: y');
  });
  it('falls back to channel when thread_id is absent (DM)', () => {
    const dm = row({ channel: 'dm-1', text: 'hey' });
    delete dm.thread_id; // DMs carry no topic thread
    expect(formatRow(dm)).toBe('[tg dm-1] alice: hey');
  });
  it('uses the raw platform name for non-telegram', () => {
    expect(formatRow(row({ platform: 'discord', thread_id: 'g1', text: 'd' }))).toBe(
      '[discord g1] alice: d',
    );
  });
});

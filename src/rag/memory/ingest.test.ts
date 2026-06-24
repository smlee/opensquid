/**
 * Tests for the always-on RAG ingest write (T-memory-foundation). Uses a fake `RagBackend` recording
 * `storeLesson` calls + injected `readEntries` / `resolveScope` seams (no real DB / transcript).
 */
import { describe, expect, it } from 'vitest';

import type { DeleteResult, Lesson, RagBackend, RecallScope } from '../types.js';
import { ingestTurn } from './ingest.js';
import type { TranscriptMessageEntry } from './transcript_entries.js';

function fakeBackend(): { backend: RagBackend; stored: Lesson[] } {
  const stored: Lesson[] = [];
  const backend: RagBackend = {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: () => Promise.resolve([]),
    storeLesson: (l) => {
      stored.push(l);
      return Promise.resolve();
    },
    deleteLesson: () => Promise.resolve({ deleted: true } as unknown as DeleteResult),
  };
  return { backend, stored };
}

const entry = (over: Partial<TranscriptMessageEntry>): TranscriptMessageEntry => ({
  uuid: 'x',
  timestamp: '2026-06-24T00:00:00Z',
  role: 'user',
  content: 'body',
  hasTool: false,
  ...over,
});

const reads = (entries: TranscriptMessageEntry[]) => () => Promise.resolve(entries);
const scope = (namespace: string | null) => () => Promise.resolve<RecallScope>({ namespace });

describe('ingestTurn', () => {
  it('writes one project-scoped Lesson per entry, id = uuid, correct provenance', async () => {
    const { backend, stored } = fakeBackend();
    const entries = [
      entry({ uuid: 'e1', role: 'user', content: 'hello', hasTool: false }),
      entry({ uuid: 'e2', role: 'assistant', content: 'world', hasTool: true }),
    ];
    const n = await ingestTurn({
      backend,
      transcriptPath: '/ignored',
      readEntries: reads(entries),
      resolveScope: scope('proj-1'),
    });
    expect(n).toBe(2);
    expect(stored.map((l) => l.id)).toEqual(['e1', 'e2']);
    expect(stored[0]?.author).toBe('user'); // genuine user prose ⇒ eviction-immune
    expect(stored[1]?.author).toBe('agent'); // assistant output ⇒ reclaimable
    for (const l of stored) {
      expect(l.tier).toBe('project');
      expect(l.namespace).toBe('proj-1');
      expect(l.source).toBe('turn-ingest');
    }
    expect(stored[0]?.tags).toEqual(['role:user']);
    expect(stored[1]?.tags).toEqual(['role:assistant', 'role:tool']); // hasTool ⇒ role:tool
  });

  it("marks the user's own words author:'user' (immune) but tool-result deliveries author:'agent'", async () => {
    const { backend, stored } = fakeBackend();
    await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: reads([
        entry({ uuid: 'prose', role: 'user', content: 'do the thing', hasTool: false }),
        entry({
          uuid: 'toolres',
          role: 'user',
          content: '[tool_result] big output',
          hasTool: true,
        }),
        entry({ uuid: 'asst', role: 'assistant', content: 'done', hasTool: false }),
      ]),
      resolveScope: scope('p'),
    });
    // The human's words are immune (never silently pruned); a tool-result delivery (also role:user) is not.
    expect(stored.find((l) => l.id === 'prose')?.author).toBe('user');
    expect(stored.find((l) => l.id === 'toolres')?.author).toBe('agent');
    expect(stored.find((l) => l.id === 'asst')?.author).toBe('agent');
  });

  it('does NOT collapse identical-content messages with distinct uuids', async () => {
    const { backend, stored } = fakeBackend();
    await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: reads([
        entry({ uuid: 'd1', content: 'ok' }),
        entry({ uuid: 'd2', content: 'ok' }),
      ]),
      resolveScope: scope('p'),
    });
    expect(stored.map((l) => l.id)).toEqual(['d1', 'd2']); // two distinct rows
  });

  it('classifies durability: plain ⇒ durable, HANDOFF ⇒ point_in_time', async () => {
    const { backend, stored } = fakeBackend();
    await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: reads([
        entry({ uuid: 'p', content: 'just a normal turn' }),
        entry({ uuid: 'h', content: 'HANDOFF: pick up here next session' }),
      ]),
      resolveScope: scope('p'),
    });
    expect(stored.find((l) => l.id === 'p')?.durability).toBe('durable');
    expect(stored.find((l) => l.id === 'h')?.durability).toBe('point_in_time');
  });

  it('stores content verbatim (no truncation)', async () => {
    const { backend, stored } = fakeBackend();
    const big = 'x'.repeat(60_000);
    await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: reads([entry({ uuid: 'big', content: big })]),
      resolveScope: scope(null),
    });
    expect(stored[0]?.content).toBe(big);
    expect(stored[0]?.content).toHaveLength(60_000);
  });

  it('is idempotent at the id level across re-scans (real backend upserts by id)', async () => {
    const { backend, stored } = fakeBackend();
    const read = reads([entry({ uuid: 'a' }), entry({ uuid: 'b' })]);
    await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: read,
      resolveScope: scope('p'),
    });
    const first = stored.map((l) => l.id);
    await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: read,
      resolveScope: scope('p'),
    });
    const second = stored.slice(first.length).map((l) => l.id);
    expect(second).toEqual(first); // same ids ⇒ a real upsert dedupes
  });

  it('writes every entry present (full-scan ⇒ a missed earlier turn is backfilled)', async () => {
    const { backend, stored } = fakeBackend();
    await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: reads([entry({ uuid: 'old' }), entry({ uuid: 'mid' }), entry({ uuid: 'new' })]),
      resolveScope: scope('p'),
    });
    expect(stored.map((l) => l.id)).toEqual(['old', 'mid', 'new']);
  });

  it('writes nothing and skips scope resolution for an empty transcript', async () => {
    const { backend, stored } = fakeBackend();
    let scopeCalls = 0;
    const n = await ingestTurn({
      backend,
      transcriptPath: '/x',
      readEntries: reads([]),
      resolveScope: () => {
        scopeCalls++;
        return Promise.resolve<RecallScope>({ namespace: 'p' });
      },
    });
    expect(n).toBe(0);
    expect(stored).toHaveLength(0);
    expect(scopeCalls).toBe(0);
  });
});

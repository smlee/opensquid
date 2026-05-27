/**
 * CMP.3 — compression-candidate collector tests.
 *
 * Covers: collect-on-window, dedup-within-window, no-citations no-op,
 * read-by-group, null-safety (absent/malformed buffer), empty-group
 * guard, and OPENSQUID_HOME isolation.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { candidatesBufferPath, collectCandidates, readCandidates } from './compress_candidates.js';

const SID = 'cmp3-sess';

describe('compress_candidates (CMP.3)', () => {
  let home: string;
  let prior: string | undefined;

  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'cmp3-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('collects a window from a promoted lesson citing [m1, m2]', async () => {
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-2'],
      group: 'CMP',
    });
    const windows = await readCandidates(SID, 'CMP');
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      group: 'CMP',
      ids: ['mem-1', 'mem-2'],
      promotedLessonId: 'lesson-1',
    });
    expect(windows[0]!.collected_at).toBeDefined();
  });

  it('dedups ids within a window', async () => {
    await collectCandidates(SID, {
      id: 'lesson-1',
      citedMemoryIds: ['mem-1', 'mem-1', 'mem-2', 'mem-2'],
      group: 'CMP',
    });
    const windows = await readCandidates(SID, 'CMP');
    expect(windows[0]!.ids).toEqual(['mem-1', 'mem-2']);
  });

  it('a lesson citing no memories → no window emitted', async () => {
    await collectCandidates(SID, { id: 'lesson-1', citedMemoryIds: [], group: 'CMP' });
    // also: ids that are all blank/whitespace
    await collectCandidates(SID, { id: 'lesson-2', citedMemoryIds: ['', '  '], group: 'CMP' });
    expect(await readCandidates(SID, 'CMP')).toEqual([]);
  });

  it('reads windows filtered by group', async () => {
    await collectCandidates(SID, { id: 'l1', citedMemoryIds: ['mem-1'], group: 'CMP' });
    await collectCandidates(SID, { id: 'l2', citedMemoryIds: ['mem-9'], group: 'MAU' });
    const cmp = await readCandidates(SID, 'CMP');
    const mau = await readCandidates(SID, 'MAU');
    expect(cmp.map((w) => w.promotedLessonId)).toEqual(['l1']);
    expect(mau.map((w) => w.promotedLessonId)).toEqual(['l2']);
  });

  it('multiple windows in a group accumulate (orchestrator dedups across)', async () => {
    await collectCandidates(SID, { id: 'l1', citedMemoryIds: ['mem-1', 'mem-2'], group: 'CMP' });
    await collectCandidates(SID, { id: 'l2', citedMemoryIds: ['mem-2', 'mem-3'], group: 'CMP' });
    const windows = await readCandidates(SID, 'CMP');
    expect(windows).toHaveLength(2);
  });

  it('empty group is ignored', async () => {
    await collectCandidates(SID, { id: 'l1', citedMemoryIds: ['mem-1'], group: '  ' });
    expect(await readCandidates(SID, '  ')).toEqual([]);
  });

  it('absent buffer → readCandidates returns [] (no throw)', async () => {
    expect(await readCandidates('never', 'CMP')).toEqual([]);
  });

  it('malformed buffer → skips bad lines, no throw', async () => {
    const path = candidatesBufferPath(SID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        'garbage',
        JSON.stringify({
          group: 'CMP',
          ids: ['mem-1'],
          promotedLessonId: 'l1',
          collected_at: 'z',
        }),
        '{ broken',
      ].join('\n') + '\n',
      'utf8',
    );
    const windows = await readCandidates(SID, 'CMP');
    expect(windows).toHaveLength(1);
    expect(windows[0]!.ids).toEqual(['mem-1']);
  });
});

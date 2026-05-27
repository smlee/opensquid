/**
 * CMP.2 — satisfaction probe tests.
 *
 * Covers the D1 contract: async append-only buffer, dedup-per-group,
 * answered-rows-readable, null-safety on absent/malformed buffer, and
 * OPENSQUID_HOME isolation.
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emitProbe,
  groupFromTask,
  probeBufferPath,
  readSatisfaction,
  recordAnswer,
} from './satisfaction_probe.js';

const SID = 'cmp2-sess';

describe('satisfaction_probe (CMP.2)', () => {
  let home: string;
  let prior: string | undefined;

  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'cmp2-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('emit appends one unanswered probe; readSatisfaction excludes it', async () => {
    await emitProbe(SID, 'CMP');
    const raw = await readFile(probeBufferPath(SID), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    // unanswered → not surfaced to the orchestrator
    expect(await readSatisfaction(SID)).toEqual([]);
  });

  it('dedup: a second emit for the same open group is a no-op', async () => {
    await emitProbe(SID, 'CMP');
    await emitProbe(SID, 'CMP');
    const raw = await readFile(probeBufferPath(SID), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  it('different groups each get their own open probe', async () => {
    await emitProbe(SID, 'CMP');
    await emitProbe(SID, 'MAU');
    const raw = await readFile(probeBufferPath(SID), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('recordAnswer makes the probe readable; unanswered excluded', async () => {
    await emitProbe(SID, 'CMP');
    await emitProbe(SID, 'MAU');
    await recordAnswer(SID, 'CMP', true, 0.9);

    const answered = await readSatisfaction(SID);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ group: 'CMP', satisfied: true, confidence: 0.9 });
    expect(answered[0]!.answered_at).toBeDefined();
  });

  it('after answering, a new emit for the group opens a fresh probe', async () => {
    await emitProbe(SID, 'CMP');
    await recordAnswer(SID, 'CMP', false);
    // group is closed → a new emit should append a fresh open row
    await emitProbe(SID, 'CMP');
    const raw = await readFile(probeBufferPath(SID), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(3);
    // latest answered state is the `false` one (no newer answer yet)
    const answered = await readSatisfaction(SID);
    expect(answered).toHaveLength(1);
    expect(answered[0]!.satisfied).toBe(false);
  });

  it('latest answer per group wins on re-answer', async () => {
    await emitProbe(SID, 'CMP');
    await recordAnswer(SID, 'CMP', false);
    await emitProbe(SID, 'CMP'); // reopen
    await recordAnswer(SID, 'CMP', true);
    const answered = await readSatisfaction(SID);
    expect(answered).toHaveLength(1);
    expect(answered[0]!.satisfied).toBe(true);
  });

  it('recordAnswer with no open probe is a no-op', async () => {
    await recordAnswer(SID, 'CMP', true);
    expect(await readSatisfaction(SID)).toEqual([]);
  });

  it('absent buffer → readSatisfaction returns [] (no throw)', async () => {
    expect(await readSatisfaction('never-emitted')).toEqual([]);
  });

  it('malformed buffer → skips bad lines, no throw', async () => {
    const path = probeBufferPath(SID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      [
        'not json at all',
        JSON.stringify({ group: 'CMP', emitted_at: 'z', satisfied: true, answered_at: 'z2' }),
        '{ broken',
      ].join('\n') + '\n',
      'utf8',
    );
    const answered = await readSatisfaction(SID);
    expect(answered).toHaveLength(1);
    expect(answered[0]!.group).toBe('CMP');
  });

  it('empty group is ignored on emit', async () => {
    await emitProbe(SID, '   ');
    expect(await readSatisfaction(SID)).toEqual([]);
  });

  describe('groupFromTask', () => {
    it('derives the track prefix from a track-style taskId', () => {
      expect(groupFromTask({ taskId: 'CMP.4', id: '17', subject: 'orchestrator' })).toBe('CMP');
    });
    it('uses the bare taskId when it has no dot', () => {
      expect(groupFromTask({ taskId: 'CMP', id: '17', subject: 's' })).toBe('CMP');
    });
    it('falls back to subject when no taskId', () => {
      expect(groupFromTask({ id: '17', subject: 'compression layer' })).toBe('compression layer');
    });
    it('falls back to id when no taskId or subject', () => {
      expect(groupFromTask({ id: '17' })).toBe('17');
    });
    it('returns null for null / empty task', () => {
      expect(groupFromTask(null)).toBeNull();
      expect(groupFromTask(undefined)).toBeNull();
      expect(groupFromTask({})).toBeNull();
    });
  });
});

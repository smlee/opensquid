import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readTaskAuditCache,
  readTaskAuditHistory,
  writeTaskAuditCache,
} from './task_audit_cache.js';

let project: string;
let priorRoot: string | undefined;
let priorItem: string | undefined;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'opensquid-task-audit-'));
  await mkdir(join(project, '.opensquid'));
  priorRoot = process.env.OPENSQUID_PROJECT_ROOT;
  priorItem = process.env.OPENSQUID_ITEM_ID;
  process.env.OPENSQUID_PROJECT_ROOT = project;
  process.env.OPENSQUID_ITEM_ID = 'wg-audit-task';
});

afterEach(async () => {
  if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
  if (priorItem === undefined) delete process.env.OPENSQUID_ITEM_ID;
  else process.env.OPENSQUID_ITEM_ID = priorItem;
  await rm(project, { recursive: true, force: true });
});

describe('task audit cache', () => {
  it('survives a fresh session while remaining keyed by task and opaque cache key', async () => {
    await writeTaskAuditCache('session-one', 'pack-scope-audit', {
      hash: 'a'.repeat(64),
      verdict: 'VERDICT: GUESS_FREE',
      subjectHash: '1'.repeat(64),
    });

    await expect(readTaskAuditCache('session-two', 'pack-scope-audit')).resolves.toEqual({
      hash: 'a'.repeat(64),
      verdict: 'VERDICT: GUESS_FREE',
      subjectHash: '1'.repeat(64),
    });
    await expect(readTaskAuditCache('session-two', 'pack-plan-audit')).resolves.toBeNull();
  });

  it('preserves partial fan-out results and failures for a later lap to resume', async () => {
    await writeTaskAuditCache('session-one', 'pack-scope-audit', {
      hash: 'b'.repeat(64),
      complete: false,
      passVerdict: 'GUESS_FREE',
      failVerdict: 'UNRESOLVED',
      lenses: [{ id: 'evidence', promptHash: 'a'.repeat(64), output: 'VERDICT: GUESS_FREE' }],
      failures: [{ id: 'architecture', error: 'audit lens timed out after 600000ms' }],
      subjectHash: '2'.repeat(64),
    });

    const expected = {
      hash: 'b'.repeat(64),
      complete: false,
      passVerdict: 'GUESS_FREE',
      failVerdict: 'UNRESOLVED',
      lenses: [{ id: 'evidence', promptHash: 'a'.repeat(64), output: 'VERDICT: GUESS_FREE' }],
      failures: [{ id: 'architecture', error: 'audit lens timed out after 600000ms' }],
      subjectHash: '2'.repeat(64),
    };
    await expect(readTaskAuditCache('session-two', 'pack-scope-audit')).resolves.toEqual(expected);
    const history = await readTaskAuditHistory('session-two', 'pack-scope-audit');
    expect(history).toHaveLength(1);
    expect(history[0]?.entry).toEqual(expected);
    expect(typeof history[0]?.updatedAtMs).toBe('number');
  });

  it('refuses malformed evidence before durable publication', async () => {
    await expect(
      writeTaskAuditCache('session-one', 'pack-scope-audit', {
        hash: 'f'.repeat(64),
        verdict: 'VERDICT: GUESS_FREE',
        complete: true,
      }),
    ).rejects.toThrow('refusing malformed task audit evidence');
    await expect(readTaskAuditCache('session-two', 'pack-scope-audit')).resolves.toBeNull();
  });

  it('caps immutable retry history at 100 attempts per task/cache key', async () => {
    for (let attempt = 0; attempt < 105; attempt += 1) {
      await writeTaskAuditCache('session-one', 'bounded-history', {
        hash: 'd'.repeat(64),
        verdict: `VERDICT: UNRESOLVED\n- attempt ${String(attempt)}`,
      });
    }
    const history = await readTaskAuditHistory('session-two', 'bounded-history', 100);
    expect(history).toHaveLength(100);
    expect(history[0]?.entry.verdict).toContain('attempt 104');
    expect(history.at(-1)?.entry.verdict).toContain('attempt 5');
  });

  it('retains immutable attempts when the latest revision changes', async () => {
    await writeTaskAuditCache('session-one', 'pack-scope-audit', {
      hash: 'c'.repeat(64),
      verdict: 'VERDICT: UNRESOLVED\n- old finding',
      subjectHash: '1'.repeat(64),
    });
    await writeTaskAuditCache('session-two', 'pack-scope-audit', {
      hash: 'c'.repeat(64),
      verdict: 'VERDICT: GUESS_FREE',
      subjectHash: '2'.repeat(64),
    });

    const history = await readTaskAuditHistory('session-three', 'pack-scope-audit');
    expect(history.map(({ entry }) => entry.subjectHash)).toEqual(['2'.repeat(64), '1'.repeat(64)]);
    expect(history[1]?.entry.verdict).toContain('old finding');
  });
});

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
      hash: 'hash-1',
      verdict: 'VERDICT: GUESS_FREE',
      subjectHash: 'subject-1',
    });

    await expect(readTaskAuditCache('session-two', 'pack-scope-audit')).resolves.toEqual({
      hash: 'hash-1',
      verdict: 'VERDICT: GUESS_FREE',
      subjectHash: 'subject-1',
    });
    await expect(readTaskAuditCache('session-two', 'pack-plan-audit')).resolves.toBeNull();
  });

  it('preserves partial fan-out results and failures for a later lap to resume', async () => {
    await writeTaskAuditCache('session-one', 'pack-scope-audit', {
      hash: 'hash-2',
      verdict: '',
      complete: false,
      lenses: [{ id: 'evidence', promptHash: 'lens-hash', output: 'VERDICT: GUESS_FREE' }],
      failures: [{ id: 'architecture', error: 'audit lens timed out after 600000ms' }],
      subjectHash: 'subject-2',
    });

    const expected = {
      hash: 'hash-2',
      verdict: '',
      complete: false,
      lenses: [{ id: 'evidence', promptHash: 'lens-hash', output: 'VERDICT: GUESS_FREE' }],
      failures: [{ id: 'architecture', error: 'audit lens timed out after 600000ms' }],
      subjectHash: 'subject-2',
    };
    await expect(readTaskAuditCache('session-two', 'pack-scope-audit')).resolves.toEqual(expected);
    const history = await readTaskAuditHistory('session-two', 'pack-scope-audit');
    expect(history).toHaveLength(1);
    expect(history[0]?.entry).toEqual(expected);
    expect(typeof history[0]?.updatedAtMs).toBe('number');
  });

  it('retains immutable attempts when the latest revision changes', async () => {
    await writeTaskAuditCache('session-one', 'pack-scope-audit', {
      hash: 'policy-hash',
      verdict: 'VERDICT: UNRESOLVED\n- old finding',
      subjectHash: 'revision-one',
    });
    await writeTaskAuditCache('session-two', 'pack-scope-audit', {
      hash: 'policy-hash',
      verdict: 'VERDICT: GUESS_FREE',
      subjectHash: 'revision-two',
    });

    const history = await readTaskAuditHistory('session-three', 'pack-scope-audit');
    expect(history.map(({ entry }) => entry.subjectHash)).toEqual(['revision-two', 'revision-one']);
    expect(history[1]?.entry.verdict).toContain('old finding');
  });
});

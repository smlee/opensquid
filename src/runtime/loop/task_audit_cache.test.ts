import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTaskAuditCache, writeTaskAuditCache } from './task_audit_cache.js';

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
});

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendAuditTelemetry, readAuditTelemetryTail } from './audit_telemetry.js';
import { withLoopDb } from './loop_db.js';

let project: string;
let priorRoot: string | undefined;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'opensquid-audit-telemetry-'));
  await mkdir(join(project, '.opensquid'));
  priorRoot = process.env.OPENSQUID_PROJECT_ROOT;
  process.env.OPENSQUID_PROJECT_ROOT = project;
});

afterEach(async () => {
  if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
  await rm(project, { recursive: true, force: true });
});

const oldEntry = {
  at: '2026-07-23T00:00:00.000Z',
  model: 'reasoning',
  operation: 'cache_read' as const,
  status: 'hit' as const,
  duration_ms: 0,
};

describe('bounded audit operation telemetry', () => {
  it('retains only the newest 1000 rows per session', async () => {
    await appendAuditTelemetry('telemetry-session', oldEntry); // create owner tables
    // Owner-module fixture: bulk seed at the storage boundary, then exercise public append+tail behavior.
    await withLoopDb(async (db) => {
      await db.execute({
        sql: 'DELETE FROM audit_spawn_telemetry WHERE session_id=?',
        args: ['telemetry-session'],
      });
      await db.execute({
        sql: `WITH RECURSIVE rows(n) AS (
                VALUES(1) UNION ALL SELECT n + 1 FROM rows WHERE n < 1000
              )
              INSERT INTO audit_spawn_telemetry (session_id, entry_json)
              SELECT ?, ? FROM rows`,
        args: ['telemetry-session', JSON.stringify(oldEntry)],
      });
    });
    await appendAuditTelemetry('telemetry-session', {
      ...oldEntry,
      operation: 'model_call',
      status: 'returned',
      duration_ms: 42,
    });

    const rows = await readAuditTelemetryTail('telemetry-session', 1_000);
    expect(rows).toHaveLength(1_000);
    expect(rows[0]?.operation).toBe('cache_read');
    expect(rows.at(-1)).toMatchObject({
      operation: 'model_call',
      status: 'returned',
      duration_ms: 42,
    });
  });

  it('bounds reader requests to the newest 1000 rows', async () => {
    await appendAuditTelemetry('telemetry-session', oldEntry);
    await expect(readAuditTelemetryTail('telemetry-session', 50_000)).resolves.toHaveLength(1);
  });
});

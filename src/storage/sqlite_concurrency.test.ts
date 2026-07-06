/**
 * GS1 — the WAL + busy_timeout concurrency posture (applyConcurrencyPragmas).
 *
 * The load-bearing assertion is the SMOKE test: two independent clients over the SAME opensquid.db file, each
 * carrying the posture, writing concurrently to `task_checkpoints` must NOT throw SQLITE_BUSY. Under the
 * default rollback journal a contended writer throws immediately; with busy_timeout it waits, and WAL keeps
 * readers/writers from blocking each other.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../runtime/durable/checkpoint_store.js';
import { applyConcurrencyPragmas } from './sqlite_concurrency.js';

import type { Client } from '@libsql/client';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'osq-wal-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('applyConcurrencyPragmas', () => {
  it('sets journal_mode=WAL (persistent db-file property) and never throws', async () => {
    const client = createClient({ url: `file:${join(dir, 'a.db')}` });
    await applyConcurrencyPragmas(client);
    const rs = await client.execute('PRAGMA journal_mode');
    const mode = rs.rows[0]?.journal_mode;
    expect((typeof mode === 'string' ? mode : '').toLowerCase()).toBe('wal');
    client.close();
  });

  it('never throws even on a closed client (best-effort posture)', async () => {
    const client = createClient({ url: `file:${join(dir, 'b.db')}` });
    client.close();
    await expect(applyConcurrencyPragmas(client)).resolves.toBeUndefined();
  });

  it('SMOKE: two clients concurrently write task_checkpoints with NO SQLITE_BUSY thrown', async () => {
    const url = `file:${join(dir, 'concurrent.db')}`;
    const a: Client = createClient({ url });
    const b: Client = createClient({ url });
    await applyConcurrencyPragmas(a);
    await applyConcurrencyPragmas(b);
    const sa = new CheckpointStore(a);
    const sb = new CheckpointStore(b);
    await sa.init();
    await sb.init();

    // Interleave 100 create/update writes from BOTH connections against the same table.
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(sa.createTaskCheckpoint(`wg-a-${i}`, 'scope', i));
      writes.push(sb.createTaskCheckpoint(`wg-b-${i}`, 'scope', i));
      writes.push(sa.updateTaskStage(`wg-a-${i}`, 'plan', i + 1));
      writes.push(sb.updateTaskStage(`wg-b-${i}`, 'plan', i + 1));
    }
    await expect(Promise.all(writes)).resolves.toBeDefined(); // no SQLITE_BUSY

    expect(await sa.getTaskCheckpoint('wg-b-49')).toEqual({ stage: 'plan', scopeArtifacts: [] });
    a.close();
    b.close();
  });
});

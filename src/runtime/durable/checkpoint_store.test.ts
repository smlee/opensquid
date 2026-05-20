/**
 * Tests for `CheckpointStore` (DURABLE.1).
 *
 * Coverage matches the spec's acceptance criteria + risk callouts:
 *   1. Happy path — 4 primitives → 4 checkpoint rows, `lastCompletedStep`
 *      returns the highest one.
 *   2. Resume bindings — `as:`-named outputs replay into a name→value map.
 *   3. Errored steps re-run on resume — `status='errored'` is not counted
 *      by `lastCompletedStep`.
 *   4. Idempotent (run_id, step_idx) — re-insert overwrites, no duplicate
 *      rows, no corruption.
 *   5. Canonical JSON round-trip — Date stays ISO string, Buffer revives to
 *      Buffer in `loadBindings`.
 *   6. Multi-run isolation — bindings of one run never leak into another.
 *   7. `pruneOlderThan` removes old rows but keeps recent ones, returns the
 *      affected-row count.
 *   8. Restart-survival — same dbUrl, fresh Client → state preserved.
 *   9. Fail-mode — libsql error in `append` re-throws (no silent swallow).
 *  10. `init` is idempotent — calling twice doesn't blow up.
 *
 * Each test uses an in-memory libsql (`:memory:`) for speed; the
 * restart-survival test uses a `file:` URL with a tmpdir.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from './checkpoint_store.js';

import type { CheckpointWrite } from './checkpoint_store.js';
import type { Client } from '@libsql/client';

function write(overrides: Partial<CheckpointWrite> = {}): CheckpointWrite {
  // `asBinding` / `errorMessage` are optional in `CheckpointWrite` with
  // `exactOptionalPropertyTypes: true` — only include them when the test
  // explicitly opts in via overrides.
  const base: CheckpointWrite = {
    runId: 'run-1',
    stepIdx: 0,
    fn: 'match_regex',
    inputsHash: 'h0',
    outputs: { hit: true },
    startedAtMs: 1_000,
    completedAtMs: 1_010,
    status: 'completed',
  };
  return { ...base, ...overrides };
}

describe('CheckpointStore — happy path', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('4 primitives → 4 rows; lastCompletedStep returns the highest step', async () => {
    const store = new CheckpointStore(client);
    await store.append(write({ stepIdx: 0, fn: 'match_regex', outputs: { hit: true } }));
    await store.append(
      write({ stepIdx: 1, fn: 'llm_classify', outputs: { label: 'FOO' }, asBinding: 'label' }),
    );
    await store.append(
      write({ stepIdx: 2, fn: 'state_lookup', outputs: { count: 3 }, asBinding: 'count' }),
    );
    await store.append(
      write({ stepIdx: 3, fn: 'verdict', outputs: { level: 'block', message: 'x' } }),
    );

    const last = await store.lastCompletedStep('run-1');
    expect(last).not.toBeNull();
    expect(last?.stepIdx).toBe(3);
    expect(last?.fn).toBe('verdict');
  });

  it('lastCompletedStep returns null when no completed rows exist for a runId', async () => {
    const store = new CheckpointStore(client);
    expect(await store.lastCompletedStep('never-ran')).toBeNull();
  });

  it('init is idempotent — second call is a no-op', async () => {
    const store = new CheckpointStore(client);
    await store.init();
    await store.init();
    // Append still works.
    await store.append(write({ stepIdx: 0 }));
    expect((await store.lastCompletedStep('run-1'))?.stepIdx).toBe(0);
  });
});

describe('CheckpointStore — resume binding restoration', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('loadBindings replays as:-named outputs into a name → value map', async () => {
    const store = new CheckpointStore(client);
    await store.append(write({ stepIdx: 0, asBinding: 'hit', outputs: true }));
    await store.append(write({ stepIdx: 1, asBinding: 'label', outputs: 'FOO' }));
    await store.append(write({ stepIdx: 2, outputs: { meta: 1 } }));
    await store.append(write({ stepIdx: 3, asBinding: 'count', outputs: 42 }));

    const bindings = await store.loadBindings('run-1');
    expect(bindings).toEqual({ hit: true, label: 'FOO', count: 42 });
  });

  it('does not include bindings from other runs', async () => {
    const store = new CheckpointStore(client);
    await store.append(write({ runId: 'run-A', stepIdx: 0, asBinding: 'x', outputs: 'from-A' }));
    await store.append(write({ runId: 'run-B', stepIdx: 0, asBinding: 'x', outputs: 'from-B' }));

    const bindingsA = await store.loadBindings('run-A');
    const bindingsB = await store.loadBindings('run-B');
    expect(bindingsA).toEqual({ x: 'from-A' });
    expect(bindingsB).toEqual({ x: 'from-B' });
  });

  it('omits bindings whose step status is errored (retry semantics)', async () => {
    const store = new CheckpointStore(client);
    await store.append(write({ stepIdx: 0, asBinding: 'hit', outputs: true }));
    await store.append(
      write({
        stepIdx: 1,
        asBinding: 'label',
        outputs: null,
        status: 'errored',
        errorMessage: 'classifier timeout',
      }),
    );

    const bindings = await store.loadBindings('run-1');
    expect(bindings).toEqual({ hit: true });
    expect('label' in bindings).toBe(false);
  });

  it('round-trips Date (ISO string) and Buffer (base64 envelope) through loadBindings', async () => {
    const store = new CheckpointStore(client);
    await store.append(
      write({
        stepIdx: 0,
        asBinding: 'when',
        outputs: new Date('2026-05-20T12:00:00.000Z'),
      }),
    );
    await store.append(
      write({ stepIdx: 1, asBinding: 'blob', outputs: Buffer.from('hi', 'utf8') }),
    );

    const bindings = await store.loadBindings('run-1');
    expect(bindings.when).toBe('2026-05-20T12:00:00.000Z');
    expect(Buffer.isBuffer(bindings.blob)).toBe(true);
    expect((bindings.blob as Buffer).toString('utf8')).toBe('hi');
  });
});

describe('CheckpointStore — errored-step retry semantics', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('lastCompletedStep ignores errored steps (resume retries them)', async () => {
    const store = new CheckpointStore(client);
    await store.append(write({ stepIdx: 0, status: 'completed' }));
    await store.append(
      write({ stepIdx: 1, status: 'errored', errorMessage: 'boom', outputs: null }),
    );

    const last = await store.lastCompletedStep('run-1');
    expect(last?.stepIdx).toBe(0);
  });

  it('retry overwrites the errored row with the new completed outcome', async () => {
    const store = new CheckpointStore(client);
    await store.append(
      write({
        stepIdx: 2,
        status: 'errored',
        errorMessage: 'timeout',
        outputs: null,
      }),
    );
    // Retry succeeds — write again with same (run_id, step_idx).
    await store.append(
      write({
        stepIdx: 2,
        status: 'completed',
        outputs: 'OK',
        asBinding: 'label',
      }),
    );

    const last = await store.lastCompletedStep('run-1');
    expect(last?.stepIdx).toBe(2);
    expect(last?.status).toBe('completed');
    expect(last?.errorMessage).toBeUndefined();

    const bindings = await store.loadBindings('run-1');
    expect(bindings).toEqual({ label: 'OK' });
  });
});

describe('CheckpointStore — idempotent (run_id, step_idx) insert', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('same (run_id, step_idx) written twice — exactly one row, latest value wins', async () => {
    const store = new CheckpointStore(client);
    await store.append(write({ stepIdx: 0, fn: 'first', outputs: 1 }));
    await store.append(write({ stepIdx: 0, fn: 'second', outputs: 2 }));

    // Exactly one row per (run_id, step_idx).
    const rs = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM checkpoints WHERE run_id = ? AND step_idx = ?`,
      args: ['run-1', 0],
    });
    expect(Number(rs.rows[0]?.n ?? 0)).toBe(1);

    // Latest value wins.
    const last = await store.lastCompletedStep('run-1');
    expect(last?.fn).toBe('second');
    expect(last?.outputs).toBe(2);
  });
});

describe('CheckpointStore — pruneOlderThan', () => {
  let client: Client;
  beforeEach(() => {
    client = createClient({ url: ':memory:' });
  });
  afterEach(() => {
    client.close();
  });

  it('removes rows older than the cutoff, keeps newer rows, returns affected count', async () => {
    const store = new CheckpointStore(client);
    // 3 old rows + 2 recent rows.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const now = 2_000_000_000_000;
    const old = now - SEVEN_DAYS_MS - 1;
    const recent = now - 1_000;

    await store.append(
      write({ runId: 'r1', stepIdx: 0, completedAtMs: old, startedAtMs: old - 1 }),
    );
    await store.append(
      write({ runId: 'r1', stepIdx: 1, completedAtMs: old, startedAtMs: old - 1 }),
    );
    await store.append(
      write({ runId: 'r2', stepIdx: 0, completedAtMs: old, startedAtMs: old - 1 }),
    );
    await store.append(
      write({ runId: 'r3', stepIdx: 0, completedAtMs: recent, startedAtMs: recent - 1 }),
    );
    await store.append(
      write({ runId: 'r4', stepIdx: 0, completedAtMs: recent, startedAtMs: recent - 1 }),
    );

    const removed = await store.pruneOlderThan(SEVEN_DAYS_MS, now);
    expect(removed).toBe(3);

    const remaining = await client.execute('SELECT COUNT(*) AS n FROM checkpoints');
    expect(Number(remaining.rows[0]?.n ?? 0)).toBe(2);
  });
});

describe('CheckpointStore — restart survival', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opensquid-cp-'));
    dbPath = join(dir, 'cp.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('checkpoints persist across daemon restarts (same dbUrl, fresh Client)', async () => {
    const c1 = createClient({ url: `file:${dbPath}` });
    const s1 = new CheckpointStore(c1);
    await s1.append(write({ stepIdx: 0, asBinding: 'x', outputs: 'pre-crash' }));
    await s1.append(write({ stepIdx: 1, asBinding: 'y', outputs: 42 }));
    c1.close();

    const c2 = createClient({ url: `file:${dbPath}` });
    const s2 = new CheckpointStore(c2);
    const last = await s2.lastCompletedStep('run-1');
    expect(last?.stepIdx).toBe(1);

    const bindings = await s2.loadBindings('run-1');
    expect(bindings).toEqual({ x: 'pre-crash', y: 42 });
    c2.close();
  });
});

describe('CheckpointStore — fail-mode', () => {
  it('append re-throws on libsql error (no silent fail-open)', async () => {
    const client = createClient({ url: ':memory:' });
    const store = new CheckpointStore(client);
    await store.init();
    client.close();

    await expect(store.append(write({ stepIdx: 0 }))).rejects.toThrow();
  });
});

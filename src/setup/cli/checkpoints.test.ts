/**
 * Tests for the `opensquid checkpoints` CLI verb scaffold (DURABLE.4).
 *
 * These cover the four handlers exposed directly (commander wiring lands
 * in CLI.6):
 *
 *   list    — returns interrupted-run summaries within the window; `--all`
 *             (windowMs=null) disables the window for a full scan.
 *   show    — returns manifest + checkpoint rows + terminal flag for one run.
 *   resume  — drives an explicit resume regardless of window; returns
 *             { manifestMissing: true } when the run is unknown.
 *   clean   — pass-through to `pruneOlderThan`, returns removed count.
 */

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckpointStore } from '../../runtime/durable/checkpoint_store.js';
import { Resumer, type RuleResolver } from '../../runtime/durable/resumer.js';

import * as cli from './checkpoints.js';

import type { Client } from '@libsql/client';

let client: Client;
let store: CheckpointStore;
beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  store = new CheckpointStore(client);
  await store.init();
});
afterEach(() => {
  client.close();
});

async function seed(runId: string, completedAtMs: number, packVersion = '0.0.1'): Promise<void> {
  await store.recordRunStart({
    runId,
    packId: 'p1',
    packVersion,
    skill: 's1',
    ruleId: 'r1',
    eventKind: 'schedule',
    eventPayload: { x: 1 },
    startedAtMs: completedAtMs - 100,
  });
  await store.append({
    runId,
    stepIdx: 0,
    fn: 'op',
    inputsHash: 'h0',
    outputs: { ok: true },
    startedAtMs: completedAtMs - 1,
    completedAtMs,
    status: 'completed',
  });
}

describe('checkpoints CLI — list', () => {
  it('returns one entry per interrupted run within the window', async () => {
    const now = 100_000;
    await seed('r1', now - 5_000);
    await seed('r2', now - 10_000);
    const rows = await cli.list({ store, nowMs: () => now });
    expect(rows.map((r) => r.runId).sort()).toEqual(['r1', 'r2']);
    const r1 = rows.find((r) => r.runId === 'r1');
    expect(r1).toMatchObject({ packId: 'p1', skill: 's1', ruleId: 'r1', lastCompletedStep: 0 });
    expect(r1?.ageMs).toBe(5_000);
  });

  it('excludes runs older than the window when windowMs is set', async () => {
    const now = 1_000_000;
    await seed('stale', now - 120_000); // outside 60s default
    const rows = await cli.list({ store, windowMs: 60_000, nowMs: () => now });
    expect(rows).toHaveLength(0);
  });

  it('windowMs=null includes everything (--all flag)', async () => {
    const now = 1_000_000;
    await seed('stale', now - 120_000);
    const rows = await cli.list({ store, windowMs: null, nowMs: () => now });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runId).toBe('stale');
  });

  it('omits orphan checkpoints with no manifest', async () => {
    const now = 100_000;
    await seed('with-manifest', now - 5_000);
    // Orphan: write checkpoint without manifest
    await store.append({
      runId: 'orphan',
      stepIdx: 0,
      fn: 'op',
      inputsHash: 'h0',
      outputs: 1,
      startedAtMs: now - 5_001,
      completedAtMs: now - 5_000,
      status: 'completed',
    });
    const rows = await cli.list({ store, nowMs: () => now });
    expect(rows.map((r) => r.runId)).toEqual(['with-manifest']);
  });
});

describe('checkpoints CLI — show', () => {
  it('returns manifest + checkpoints + terminal flag for one run', async () => {
    const now = 100_000;
    await seed('alpha', now - 5_000);
    const out = await cli.show(store, 'alpha');
    expect(out.manifest?.runId).toBe('alpha');
    expect(out.checkpoints).toHaveLength(1);
    expect(out.hasTerminalMarker).toBe(false);
  });

  it('hasTerminalMarker=true after recordRunTerminal', async () => {
    const now = 100_000;
    await seed('beta', now - 5_000);
    await store.recordRunTerminal('beta', 'verdict', now - 4_990);
    const out = await cli.show(store, 'beta');
    expect(out.hasTerminalMarker).toBe(true);
  });

  it('manifest=null for unknown run', async () => {
    const out = await cli.show(store, 'nope');
    expect(out.manifest).toBeNull();
    expect(out.checkpoints).toHaveLength(0);
  });
});

describe('checkpoints CLI — resume', () => {
  it('returns manifestMissing for an unknown run', async () => {
    const resumer = new Resumer({
      store,
      evaluator: () => Promise.resolve(),
      resolver: () => Promise.resolve(null),
    });
    const out = await cli.resume(resumer, store, 'nope');
    expect(out).toEqual({ resumed: false, manifestMissing: true });
  });

  it('drives an explicit resume that bypasses the window', async () => {
    const now = 1_000_000;
    const old = now - 24 * 60 * 60_000; // 24h ago
    await seed('explicit', old);
    const resolver: RuleResolver = () =>
      Promise.resolve({ process: [{ call: 'op' }, { call: 'op' }], packVersion: '0.0.1' });
    const evaluator = vi.fn(() => Promise.resolve());
    const resumer = new Resumer({ store, evaluator, resolver, nowMs: () => now });
    const out = await cli.resume(resumer, store, 'explicit');
    expect(out.resumed).toBe(true);
    expect(evaluator).toHaveBeenCalledOnce();
  });

  it('surfaces resume reason on skip', async () => {
    const now = 100_000;
    await seed('drifted', now - 5_000, '0.0.1');
    const resumer = new Resumer({
      store,
      evaluator: () => Promise.resolve(),
      resolver: () => Promise.resolve({ process: [{ call: 'op' }], packVersion: '0.0.2' }),
      nowMs: () => now,
    });
    const out = await cli.resume(resumer, store, 'drifted');
    expect(out.resumed).toBe(false);
    expect(out.reason).toBe('pack_version_mismatch');
  });
});

describe('checkpoints CLI — clean', () => {
  it('passes through to pruneOlderThan + returns removed count', async () => {
    const now = 1_000_000;
    const SEVEN_DAYS = 7 * 24 * 60 * 60_000;
    await seed('old', now - SEVEN_DAYS - 1);
    await seed('new', now - 1_000);
    const out = await cli.clean({ store, olderThanMs: SEVEN_DAYS, nowMs: () => now });
    expect(out.removed).toBe(1);
  });
});

/** Tests for `TraceReader` (OBSERVE.1) — all 4 status paths, listRecent
 *  + EXPLAIN, tail follow + abort, JSON + OTEL export, secret-stripping,
 *  UTF-8-safe truncation, nonexistent runId.
 */

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../durable/checkpoint_store.js';

import { TraceReader } from './trace_reader.js';

import type { Client } from '@libsql/client';

interface SeedStep {
  stepIdx: number;
  fn?: string;
  startedAtMs: number;
  completedAtMs: number;
  outputs?: unknown;
  status?: 'completed' | 'errored';
  asBinding?: string;
  errorMessage?: string;
}

interface SeedRun {
  runId: string;
  packId?: string;
  skill?: string;
  ruleId?: string;
  startedAtMs?: number;
  terminalAtMs?: number;
  terminalOutcome?: string;
  steps: SeedStep[];
}

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

async function seedRun(run: SeedRun): Promise<void> {
  await store.recordRunStart({
    runId: run.runId,
    packId: run.packId ?? 'p1',
    packVersion: '0.0.1',
    skill: run.skill ?? 's1',
    ruleId: run.ruleId ?? 'r1',
    eventKind: 'schedule',
    eventPayload: { seed: true },
    startedAtMs: run.startedAtMs ?? 1_000,
  });
  for (const step of run.steps) {
    await store.append({
      runId: run.runId,
      stepIdx: step.stepIdx,
      fn: step.fn ?? 'op',
      inputsHash: `h${String(step.stepIdx)}`,
      outputs: step.outputs ?? { idx: step.stepIdx },
      startedAtMs: step.startedAtMs,
      completedAtMs: step.completedAtMs,
      status: step.status ?? 'completed',
      ...(step.asBinding !== undefined ? { asBinding: step.asBinding } : {}),
      ...(step.errorMessage !== undefined ? { errorMessage: step.errorMessage } : {}),
    });
  }
  if (run.terminalAtMs !== undefined) {
    await store.recordRunTerminal(run.runId, run.terminalOutcome ?? 'verdict', run.terminalAtMs);
  }
}

describe('TraceReader.getTimeline — 4 status paths + nonexistent', () => {
  it('4-step completed run with terminal marker → status=completed', async () => {
    await seedRun({
      runId: 'run-completed',
      packId: 'ci-monitor',
      skill: 'drift-digest',
      ruleId: 'weekly-report',
      startedAtMs: 1_000,
      terminalAtMs: 5_300,
      steps: [
        { stepIdx: 0, fn: 'match_regex', startedAtMs: 1_010, completedAtMs: 1_020 },
        {
          stepIdx: 1,
          fn: 'llm_classify',
          startedAtMs: 1_020,
          completedAtMs: 4_140,
          asBinding: 'classification',
          outputs: { label: 'drift', confidence: 0.91 },
        },
        { stepIdx: 2, fn: 'state_lookup', startedAtMs: 4_140, completedAtMs: 4_148 },
        { stepIdx: 3, fn: 'emit_verdict', startedAtMs: 4_148, completedAtMs: 4_151 },
      ],
    });
    const reader = new TraceReader(client, () => 10_000);
    const t = await reader.getTimeline('run-completed');
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(t.packId).toBe('ci-monitor');
    expect(t.skill).toBe('drift-digest');
    expect(t.ruleId).toBe('weekly-report');
    expect(t.status).toBe('completed');
    expect(t.events).toHaveLength(4);
    expect(t.events[1]?.asBinding).toBe('classification');
    expect(t.completedAtMs).toBe(5_300);
    expect(t.totalDurationMs).toBe(4_300);
    expect(t.events[1]?.durationMs).toBe(3_120);
  });

  it('2 completed + 1 errored + terminal marker → status=errored', async () => {
    await seedRun({
      runId: 'run-errored',
      startedAtMs: 1_000,
      terminalAtMs: 1_200,
      terminalOutcome: 'error',
      steps: [
        { stepIdx: 0, startedAtMs: 1_010, completedAtMs: 1_020 },
        { stepIdx: 1, startedAtMs: 1_020, completedAtMs: 1_050 },
        {
          stepIdx: 2,
          startedAtMs: 1_050,
          completedAtMs: 1_100,
          status: 'errored',
          errorMessage: 'classifier timeout',
        },
      ],
    });
    const reader = new TraceReader(client, () => 5_000);
    const t = await reader.getTimeline('run-errored');
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(t.status).toBe('errored');
    expect(t.events[2]?.status).toBe('errored');
    expect(t.events[2]?.errorMessage).toBe('classifier timeout');
  });

  it('no terminal + last step within 60s → status=in_flight', async () => {
    const now = 1_000_000;
    await seedRun({
      runId: 'run-in-flight',
      startedAtMs: now - 30_000,
      steps: [{ stepIdx: 0, startedAtMs: now - 30_000, completedAtMs: now - 20_000 }],
    });
    const reader = new TraceReader(client, () => now);
    const t = await reader.getTimeline('run-in-flight');
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(t.status).toBe('in_flight');
    expect(t.completedAtMs).toBeNull();
  });

  it('no terminal + last step older than 60s → status=interrupted', async () => {
    const now = 1_000_000;
    await seedRun({
      runId: 'run-interrupted',
      startedAtMs: now - 300_000,
      steps: [{ stepIdx: 0, startedAtMs: now - 300_000, completedAtMs: now - 200_000 }],
    });
    const reader = new TraceReader(client, () => now);
    const t = await reader.getTimeline('run-interrupted');
    expect(t).not.toBeNull();
    if (t === null) return;
    expect(t.status).toBe('interrupted');
    expect(t.completedAtMs).toBeNull();
  });

  it('returns null when no manifest exists', async () => {
    const reader = new TraceReader(client);
    expect(await reader.getTimeline('nope')).toBeNull();
  });
});

describe('TraceReader.listRecent', () => {
  it('limit + packId + status filters', async () => {
    // 3 runs across 2 packs
    await seedRun({
      runId: 'a',
      packId: 'ci-monitor',
      startedAtMs: 1_000,
      terminalAtMs: 1_500,
      steps: [{ stepIdx: 0, startedAtMs: 1_010, completedAtMs: 1_020 }],
    });
    await seedRun({
      runId: 'b',
      packId: 'ci-monitor',
      startedAtMs: 2_000,
      terminalAtMs: 2_500,
      terminalOutcome: 'error',
      steps: [{ stepIdx: 0, startedAtMs: 2_010, completedAtMs: 2_020, status: 'errored' }],
    });
    await seedRun({
      runId: 'c',
      packId: 'other-pack',
      startedAtMs: 3_000,
      terminalAtMs: 3_500,
      steps: [{ stepIdx: 0, startedAtMs: 3_010, completedAtMs: 3_020 }],
    });
    const reader = new TraceReader(client, () => 10_000);
    const ciCompleted = await reader.listRecent({
      packId: 'ci-monitor',
      status: 'completed',
      limit: 10,
    });
    expect(ciCompleted).toHaveLength(1);
    expect(ciCompleted[0]?.runId).toBe('a');

    const ciErrored = await reader.listRecent({ packId: 'ci-monitor', status: 'errored' });
    expect(ciErrored).toHaveLength(1);
    expect(ciErrored[0]?.runId).toBe('b');

    const all = await reader.listRecent({ limit: 10 });
    expect(all.map((e) => e.runId)).toEqual(['c', 'b', 'a']);

    const allBounded = await reader.listRecent({ limit: 2 });
    expect(allBounded).toHaveLength(2);
  });

  it('verifies index on run_manifests.started_at_ms is used by EXPLAIN QUERY PLAN', async () => {
    const explain = await client.execute({
      sql: `EXPLAIN QUERY PLAN
            SELECT m.run_id FROM run_manifests m WHERE m.started_at_ms >= ?
            ORDER BY m.started_at_ms DESC LIMIT 50`,
      args: [0],
    });
    const plan = explain.rows
      .map((r) => {
        const rec = r as Record<string, unknown>;
        const parts: string[] = [];
        for (const v of Object.values(rec)) {
          if (typeof v === 'string') parts.push(v);
          else if (typeof v === 'number' || typeof v === 'bigint') parts.push(v.toString());
        }
        return parts.join(' ');
      })
      .join('\n');
    expect(plan.toLowerCase()).toContain('idx_run_manifests_started_at');
  });
});

describe('TraceReader.tail — follow semantics', () => {
  it('yields events appended after sinceMs and aborts cleanly; clamps interval to 100ms floor', async () => {
    await seedRun({
      runId: 'tail-run',
      startedAtMs: 0,
      steps: [{ stepIdx: 0, startedAtMs: 5, completedAtMs: 10 }],
    });
    const reader = new TraceReader(client);
    const ac = new AbortController();
    const iter = await reader.tail({ sinceMs: 5, intervalMs: 100, signal: ac.signal });
    const collected: number[] = [];
    for await (const ev of iter) {
      collected.push(ev.stepIdx);
      if (collected.length === 1) {
        await store.append({
          runId: 'tail-run',
          stepIdx: 1,
          fn: 'op',
          inputsHash: 'h1',
          outputs: { idx: 1 },
          startedAtMs: 20,
          completedAtMs: 30,
          status: 'completed',
        });
      }
      if (collected.length === 2) ac.abort();
    }
    expect(collected).toEqual([0, 1]);

    // Clamp interval to 100ms floor — pre-abort iter must terminate cleanly.
    const ac2 = new AbortController();
    const iter2 = await reader.tail({ sinceMs: 1_000, intervalMs: 1, signal: ac2.signal });
    ac2.abort();
    let extra = 0;
    for await (const ev of iter2) {
      void ev;
      if (++extra > 10) break;
    }
    expect(extra).toBe(0);
  });
});

describe('TraceReader.export', () => {
  it('json export round-trips runId / packId / events', async () => {
    await seedRun({
      runId: 'exp-1',
      startedAtMs: 0,
      terminalAtMs: 100,
      steps: [{ stepIdx: 0, startedAtMs: 5, completedAtMs: 10 }],
    });
    const reader = new TraceReader(client, () => 1_000);
    const s = await reader.export('exp-1', 'json');
    const parsed = JSON.parse(s) as { runId: string; events: { stepIdx: number }[] };
    expect(parsed.runId).toBe('exp-1');
    expect(parsed.events).toHaveLength(1);
  });

  it('otel export produces 32-hex trace_id and 16-hex span_id per event', async () => {
    await seedRun({
      runId: 'otel-1',
      startedAtMs: 1_000,
      terminalAtMs: 2_000,
      steps: [
        { stepIdx: 0, startedAtMs: 1_010, completedAtMs: 1_020 },
        { stepIdx: 1, startedAtMs: 1_020, completedAtMs: 1_500 },
      ],
    });
    const reader = new TraceReader(client, () => 3_000);
    const s = await reader.export('otel-1', 'otel');
    interface OtelOut {
      resourceSpans: {
        scopeSpans: {
          spans: { trace_id: string; span_id: string; start_time_unix_nano: string }[];
        }[];
      }[];
    }
    const parsed = JSON.parse(s) as OtelOut;
    const spans = parsed.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(span.span_id).toMatch(/^[0-9a-f]{16}$/);
      // start_time_unix_nano must be a numeric string (ns).
      expect(span.start_time_unix_nano).toMatch(/^\d+$/);
    }
    // All spans in one trace share the same trace_id.
    const traceIds = new Set(spans.map((sp) => sp.trace_id));
    expect(traceIds.size).toBe(1);
    // Span IDs differ across steps.
    const spanIds = new Set(spans.map((sp) => sp.span_id));
    expect(spanIds.size).toBe(2);
  });

  it('export returns "" for nonexistent runId', async () => {
    const reader = new TraceReader(client);
    expect(await reader.export('nope', 'json')).toBe('');
    expect(await reader.export('nope', 'otel')).toBe('');
  });
});

describe('TraceReader — preview redaction + UTF-8 safety', () => {
  it('redacts secret-bearing keys (api_key / token / password) in outputsPreview', async () => {
    await seedRun({
      runId: 'secret-run',
      startedAtMs: 0,
      terminalAtMs: 100,
      steps: [
        {
          stepIdx: 0,
          startedAtMs: 5,
          completedAtMs: 10,
          outputs: {
            api_key: 'sk_live_ABCDEFGH1234567890',
            token: 'xoxb-superSecretToken12345',
            password: 'hunter2hunter2hunter2',
            ok: true,
          },
        },
      ],
    });
    const reader = new TraceReader(client, () => 1_000);
    const t = await reader.getTimeline('secret-run');
    const preview = t?.events[0]?.outputsPreview ?? '';
    expect(preview).toContain('<redacted>');
    expect(preview).not.toContain('sk_live_ABCDEFGH1234567890');
    expect(preview).not.toContain('xoxb-superSecretToken12345');
    expect(preview).not.toContain('hunter2hunter2hunter2');
    // Key names preserved so an audit reader sees WHERE the leak would have been.
    expect(preview).toContain('api_key');
    expect(preview).toContain('token');
    expect(preview).toContain('password');
  });

  it('truncates >200-codepoint outputs without splitting mid-codepoint', async () => {
    await seedRun({
      runId: 'utf8-run',
      startedAtMs: 0,
      terminalAtMs: 100,
      steps: [
        { stepIdx: 0, startedAtMs: 5, completedAtMs: 10, outputs: { msg: '🐙'.repeat(250) } },
      ],
    });
    const reader = new TraceReader(client, () => 1_000);
    const t = await reader.getTimeline('utf8-run');
    const preview = t?.events[0]?.outputsPreview ?? '';
    expect(preview).not.toContain('�'); // no lone surrogate / replacement char
    expect(Array.from(preview).length).toBeLessThanOrEqual(200);
  });
});

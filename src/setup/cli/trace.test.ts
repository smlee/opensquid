/**
 * Tests for `opensquid trace` CLI (OBSERVE.2).
 *
 * Two test surfaces:
 *
 *   1. `renderTimeline` / `renderMarkdown` / `renderTailEvent` pure renderers
 *      — snapshot-style assertions on the rendered string. Color is forced
 *      off so the expected output is ANSI-free; one extra test forces color
 *      on to confirm ANSI codes appear.
 *
 *   2. End-to-end commander invocations through `registerTraceCommand` with
 *      an injected in-memory libsql client. Covers `show`, `tail`,
 *      `export --format <json|md|otel>`, the `--follow` SIGINT abort path,
 *      and the nonexistent-run error path.
 *
 * Fixture: a 4-step ci-monitor/drift-digest/weekly-report run that mirrors
 * the spec's "sample output" exactly. Step 1 carries an `asBinding` + an
 * outputs preview so the rendered timeline matches the spec layout.
 */

import { createClient } from '@libsql/client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CheckpointStore } from '../../runtime/durable/checkpoint_store.js';

import { registerTraceCommand, renderMarkdown, renderTailEvent, renderTimeline } from './trace.js';

import type { Client } from '@libsql/client';
import type { TraceTimeline } from '../../runtime/observability/index.js';

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

/**
 * Seed a 4-step completed run matching the spec's sample output. Wall-clock
 * values are chosen so the rendered durations are 12 / 3120 / 8 / 3ms with
 * total 4203ms — same numbers as the spec.
 */
async function seedSampleRun(runId: string): Promise<void> {
  const startedAtMs = Date.UTC(2026, 4, 20, 9, 0, 0); // 2026-05-20T09:00:00Z
  await store.recordRunStart({
    runId,
    packId: 'ci-monitor',
    packVersion: '0.0.1',
    skill: 'drift-digest',
    ruleId: 'weekly-report',
    eventKind: 'schedule',
    eventPayload: { weekly: true },
    startedAtMs,
  });
  await store.append({
    runId,
    stepIdx: 0,
    fn: 'match_regex',
    inputsHash: 'h0',
    outputs: { matched: true },
    startedAtMs: startedAtMs + 0,
    completedAtMs: startedAtMs + 12,
    status: 'completed',
  });
  await store.append({
    runId,
    stepIdx: 1,
    fn: 'llm_classify',
    inputsHash: 'h1',
    outputs: { label: 'drift', confidence: 0.91 },
    startedAtMs: startedAtMs + 12,
    completedAtMs: startedAtMs + 12 + 3_120,
    status: 'completed',
    asBinding: 'classification',
  });
  await store.append({
    runId,
    stepIdx: 2,
    fn: 'state_lookup',
    inputsHash: 'h2',
    outputs: { value: 'x' },
    startedAtMs: startedAtMs + 12 + 3_120,
    completedAtMs: startedAtMs + 12 + 3_120 + 8,
    status: 'completed',
    asBinding: 'last_run',
  });
  await store.append({
    runId,
    stepIdx: 3,
    fn: 'emit_verdict',
    inputsHash: 'h3',
    outputs: { ok: true },
    startedAtMs: startedAtMs + 12 + 3_120 + 8,
    completedAtMs: startedAtMs + 12 + 3_120 + 8 + 3,
    status: 'completed',
  });
  await store.recordRunTerminal(runId, 'verdict', startedAtMs + 4_203);
}

function buildTimelineFixture(): TraceTimeline {
  return {
    runId: 'abc12345-aaaa-bbbb-cccc-deadbeefcafe',
    packId: 'ci-monitor',
    skill: 'drift-digest',
    ruleId: 'weekly-report',
    eventKind: 'schedule',
    startedAtMs: Date.UTC(2026, 4, 20, 9, 0, 0),
    completedAtMs: Date.UTC(2026, 4, 20, 9, 0, 0) + 4_203,
    totalDurationMs: 4_203,
    status: 'completed',
    events: [
      {
        runId: 'abc12345-aaaa-bbbb-cccc-deadbeefcafe',
        stepIdx: 0,
        fn: 'match_regex',
        inputsHash: 'h0',
        outputs: { matched: true },
        startedAtMs: 0,
        completedAtMs: 12,
        durationMs: 12,
        status: 'completed',
      },
      {
        runId: 'abc12345-aaaa-bbbb-cccc-deadbeefcafe',
        stepIdx: 1,
        fn: 'llm_classify',
        inputsHash: 'h1',
        outputs: { label: 'drift', confidence: 0.91 },
        outputsPreview: '{"confidence":0.91,"label":"drift"}',
        startedAtMs: 12,
        completedAtMs: 3_132,
        durationMs: 3_120,
        status: 'completed',
        asBinding: 'classification',
      },
      {
        runId: 'abc12345-aaaa-bbbb-cccc-deadbeefcafe',
        stepIdx: 2,
        fn: 'state_lookup',
        inputsHash: 'h2',
        outputs: null,
        startedAtMs: 3_132,
        completedAtMs: 3_140,
        durationMs: 8,
        status: 'completed',
        asBinding: 'last_run',
      },
      {
        runId: 'abc12345-aaaa-bbbb-cccc-deadbeefcafe',
        stepIdx: 3,
        fn: 'emit_verdict',
        inputsHash: 'h3',
        outputs: null,
        startedAtMs: 3_140,
        completedAtMs: 3_143,
        durationMs: 3,
        status: 'completed',
      },
    ],
  };
}

describe('renderTimeline — pure render', () => {
  it('snapshots a completed 4-step timeline (no color, fixed 20-char bar)', () => {
    const t = buildTimelineFixture();
    const out = renderTimeline(t, { color: false, barWidth: 20 });
    expect(out).toMatchInlineSnapshot(`
      "ci-monitor/drift-digest/weekly-report  run abc12345
        2026-05-20T09:00:00.000Z  4203ms  completed

        ✓  0 match_regex          [█                   ]  12ms
        ✓  1 llm_classify         [███████████████     ]  3120ms
              as: classification
              out: {"confidence":0.91,"label":"drift"}
        ✓  2 state_lookup         [█                   ]  8ms
              as: last_run
        ✓  3 emit_verdict         [█                   ]  3ms"
    `);
  });

  it('errored step renders red ✗ + err: line (ANSI codes present when color forced)', () => {
    const t = buildTimelineFixture();
    t.events[2] = {
      ...t.events[2]!,
      status: 'errored',
      errorMessage: 'state backend timeout',
    };
    t.status = 'errored';
    const out = renderTimeline(t, { color: true, barWidth: 20 });
    // ANSI red sequence for the cross + err line
    expect(out).toContain('[31m✗[39m');
    expect(out).toContain('[31m        err: state backend timeout[39m');
    expect(out).toContain('[31merrored[39m');
  });

  it('in_flight status uses yellow; interrupted uses magenta', () => {
    const t = buildTimelineFixture();
    t.status = 'in_flight';
    t.completedAtMs = null;
    const inFlight = renderTimeline(t, { color: true, barWidth: 20 });
    expect(inFlight).toContain('[33min_flight[39m');
    t.status = 'interrupted';
    const interrupted = renderTimeline(t, { color: true, barWidth: 20 });
    expect(interrupted).toContain('[35minterrupted[39m');
  });

  it('color=false produces zero ANSI escape sequences (TTY-detect off / piped path)', () => {
    const t = buildTimelineFixture();
    const out = renderTimeline(t, { color: false, barWidth: 20 });
    expect(out).not.toMatch(/\[/);
  });

  it('does not wrap on 80-col terminal — every line ≤ 80 visible chars at 20-char bar', () => {
    const t = buildTimelineFixture();
    const out = renderTimeline(t, { color: false, barWidth: 20 });
    for (const line of out.split('\n')) {
      // Count user-visible chars (codepoints) — `█` is one codepoint.
      expect(Array.from(line).length).toBeLessThanOrEqual(80);
    }
  });
});

describe('renderTailEvent — one-line tail row', () => {
  it('renders a completed event with truncated runId prefix', () => {
    const e = buildTimelineFixture().events[1]!;
    const out = renderTailEvent(e, { color: false });
    expect(out).toBe('✓ abc12345  1 llm_classify         3120ms');
  });
});

describe('renderMarkdown — GFM-safe export', () => {
  it('renders a valid GFM table with header + step rows + details section', () => {
    const t = buildTimelineFixture();
    const md = renderMarkdown(t);
    expect(md).toContain('# Trace `abc12345-aaaa-bbbb-cccc-deadbeefcafe`');
    expect(md).toContain('| # | Function | Duration | Status | as |');
    expect(md).toContain('|---|----------|----------|--------|----|');
    expect(md).toContain('| 1 | `llm_classify` | 3120ms | completed | classification |');
    expect(md).toContain('## Details');
    expect(md).toContain('### Step 1 — `llm_classify`');
    // No ANSI codes in markdown output.
    expect(md).not.toMatch(/\[/);
    // No `█` glyphs (GitHub strips them inconsistently in code blocks).
    expect(md).not.toContain('█');
  });
});

// ---------------------------------------------------------------------------
// Commander wiring — drives the registered subcommand tree end-to-end.
// ---------------------------------------------------------------------------

interface CapturedIo {
  stdout: string;
  stderr: string;
}

function buildProgram(deps: { client: Client; abort?: AbortController }): {
  program: Command;
  io: CapturedIo;
} {
  const io: CapturedIo = { stdout: '', stderr: '' };
  const program = new Command().name('opensquid').description('test harness').exitOverride();
  registerTraceCommand(program, {
    openClient: () => deps.client,
    stdout: (s) => {
      io.stdout += s;
    },
    stderr: (s) => {
      io.stderr += s;
    },
    ...(deps.abort !== undefined ? { abort: deps.abort } : {}),
  });
  return { program, io };
}

describe('opensquid trace <runId> — show', () => {
  it('renders the sample run; exit code 0', async () => {
    await seedSampleRun('sample-run-id');
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['trace', 'sample-run-id', '--db', ':memory:', '--no-color'], {
      from: 'user',
    });
    expect(io.stdout).toContain('ci-monitor/drift-digest/weekly-report  run sample-r');
    expect(io.stdout).toContain('match_regex');
    expect(io.stdout).toContain('llm_classify');
    expect(io.stdout).toContain('as: classification');
    expect(io.stderr).toBe('');
    expect(process.exitCode).not.toBe(1);
  });

  it('nonexistent runId → clean error to stderr, exitCode 1', async () => {
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['trace', 'no-such-run', '--db', ':memory:'], { from: 'user' });
    expect(io.stdout).toBe('');
    expect(io.stderr).toContain('no run found for id "no-such-run"');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });
});

describe('opensquid trace export — json | md | otel', () => {
  it('--format json emits parseable JSON with full TraceTimeline', async () => {
    await seedSampleRun('export-json-run');
    const { program, io } = buildProgram({ client });
    await program.parseAsync(
      ['trace', 'export', 'export-json-run', '--format', 'json', '--db', ':memory:'],
      { from: 'user' },
    );
    const parsed = JSON.parse(io.stdout) as TraceTimeline;
    expect(parsed.runId).toBe('export-json-run');
    expect(parsed.packId).toBe('ci-monitor');
    expect(parsed.skill).toBe('drift-digest');
    expect(parsed.events).toHaveLength(4);
    expect(parsed.events[1]?.fn).toBe('llm_classify');
  });

  it('--format md emits GFM with table + heading', async () => {
    await seedSampleRun('export-md-run');
    const { program, io } = buildProgram({ client });
    await program.parseAsync(
      ['trace', 'export', 'export-md-run', '--format', 'md', '--db', ':memory:'],
      { from: 'user' },
    );
    expect(io.stdout).toContain('# Trace `export-md-run`');
    expect(io.stdout).toContain('| # | Function | Duration | Status | as |');
    expect(io.stdout).toContain('| 1 | `llm_classify` | 3120ms | completed | classification |');
  });

  it('--format otel emits OTLP/JSON with valid trace_id + span_id shape', async () => {
    await seedSampleRun('export-otel-run');
    const { program, io } = buildProgram({ client });
    await program.parseAsync(
      ['trace', 'export', 'export-otel-run', '--format', 'otel', '--db', ':memory:'],
      { from: 'user' },
    );
    interface OtelLike {
      resourceSpans: {
        resource: { attributes: { key: string; value: { stringValue?: string } }[] };
        scopeSpans: { spans: { trace_id: string; span_id: string; name: string }[] }[];
      }[];
    }
    const parsed = JSON.parse(io.stdout) as OtelLike;
    const rs = parsed.resourceSpans[0]!;
    expect(rs.resource.attributes[0]?.value.stringValue).toBe('opensquid/ci-monitor');
    const spans = rs.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(4);
    for (const s of spans) {
      expect(s.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(s.span_id).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(spans[1]?.name).toBe('llm_classify');
  });

  it('--format bogus surfaces a clean error, exitCode 1', async () => {
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program, io } = buildProgram({ client });
    await program.parseAsync(
      ['trace', 'export', 'any-run', '--format', 'wat', '--db', ':memory:'],
      { from: 'user' },
    );
    expect(io.stderr).toContain('unknown --format "wat"');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });
});

describe('opensquid trace tail --follow — abort cleanup', () => {
  it('SIGINT-equivalent abort exits cleanly with no leaked timer', async () => {
    const abort = new AbortController();
    const { program } = buildProgram({ client, abort });
    // Abort before parseAsync runs the loop body — the tail generator sees
    // the aborted signal on first iteration and returns immediately.
    abort.abort();
    const before = process.listenerCount('SIGINT');
    await program.parseAsync(
      ['trace', 'tail', '--db', ':memory:', '--follow', '--interval', '100', '--no-color'],
      { from: 'user' },
    );
    const after = process.listenerCount('SIGINT');
    // Listener was installed in the action AND removed in the finally block.
    expect(after).toBe(before);
  });

  it('tail without --follow returns the first batch and exits (no leaked listener)', async () => {
    // Seed a row stamped FAR in the future so tail's `sinceMs = Date.now()`
    // cursor sees it on the first poll. Without --follow, the action aborts
    // after yielding the first event — so this also exercises the
    // "auto-stop on first batch" path.
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    await store.recordRunStart({
      runId: 'tail-batch-run',
      packId: 'ci-monitor',
      packVersion: '0.0.1',
      skill: 'drift-digest',
      ruleId: 'weekly-report',
      eventKind: 'schedule',
      eventPayload: {},
      startedAtMs: farFuture,
    });
    await store.append({
      runId: 'tail-batch-run',
      stepIdx: 0,
      fn: 'match_regex',
      inputsHash: 'h0',
      outputs: { ok: true },
      startedAtMs: farFuture,
      completedAtMs: farFuture + 10,
      status: 'completed',
    });
    const abort = new AbortController();
    const { program, io } = buildProgram({ client, abort });
    const before = process.listenerCount('SIGINT');
    await program.parseAsync(
      ['trace', 'tail', '--db', ':memory:', '--interval', '100', '--no-color'],
      { from: 'user' },
    );
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
    expect(io.stdout).toContain('match_regex');
  });
});

/**
 * Tests for `opensquid checkpoints` CLI verb group (CLI.6 + DURABLE.4
 * scaffold).
 *
 * Two surfaces share this file:
 *
 *   A. Pure handlers (`list` / `show` / `resume` / `clean` exported
 *      functions) — DURABLE.4 scaffold. Direct-import callers verify
 *      window override + orphan filtering + pruneOlderThan pass-through.
 *
 *   B. Commander-wired verbs (`registerCheckpoints`) — CLI.6. Drives
 *      parseAsync against an in-memory libsql client. Verifies:
 *        list   — table render + --limit cap + empty path
 *        show   — RAW JSONL output + missing-runId exit 1 + manifest+
 *                 checkpoint+terminal line shape
 *        resume — stale-run override with --yes + missing-manifest exit 1
 *                 + no-resumer-factory exit 1
 *        clean  — count reported + --older-than 30d default + --yes bypass
 */

import { createClient } from '@libsql/client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CheckpointStore } from '../../runtime/durable/checkpoint_store.js';
import { Resumer, type RuleResolver } from '../../runtime/durable/resumer.js';

import * as cli from './checkpoints.js';
import { registerCheckpoints } from './checkpoints.js';

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

// ---------------------------------------------------------------------------
// A. Pure handlers (DURABLE.4 scaffold) — preserved
// ---------------------------------------------------------------------------

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
    await seed('stale', now - 120_000);
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
    const old = now - 24 * 60 * 60_000;
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

// ---------------------------------------------------------------------------
// B. Commander-wired verbs (CLI.6) — drives parseAsync
// ---------------------------------------------------------------------------

interface CapturedIo {
  stdout: string;
  stderr: string;
}

function shareableClient(c: Client): Client {
  return new Proxy(c, {
    get(target, prop, receiver): unknown {
      if (prop === 'close') return () => undefined;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function build(deps: Parameters<typeof registerCheckpoints>[1] = {}): {
  program: Command;
  io: CapturedIo;
} {
  const io: CapturedIo = { stdout: '', stderr: '' };
  const program = new Command().name('opensquid').exitOverride();
  const shared = shareableClient(client);
  registerCheckpoints(program, {
    openClient: () => shared,
    stdout: (s) => {
      io.stdout += s;
    },
    stderr: (s) => {
      io.stderr += s;
    },
    isTty: () => false,
    ...deps,
  });
  return { program, io };
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'checkpoints', ...args];

async function withExit(body: () => Promise<void>): Promise<number> {
  const prior = process.exitCode;
  process.exitCode = 0;
  try {
    await body();
    return Number(process.exitCode ?? 0);
  } finally {
    process.exitCode = prior;
  }
}

describe('opensquid checkpoints list (commander)', () => {
  it('renders a table of interrupted runs with --interrupted', async () => {
    const now = 100_000;
    await seed('runABCDEF', now - 5_000);
    const { program, io } = build({ now: () => now });
    await program.parseAsync(argv('list', '--interrupted', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('RUN');
    expect(io.stdout).toContain('PACK');
    expect(io.stdout).toContain('STEP');
    expect(io.stdout).toContain('runABCDEF');
    expect(io.stdout).toContain('p1');
    expect(io.stdout).toContain('5s');
  });

  it('--limit caps the output rows', async () => {
    const now = 100_000;
    for (let i = 0; i < 5; i += 1) await seed(`r${String(i)}`, now - 1_000 - i);
    const { program, io } = build({ now: () => now });
    await program.parseAsync(argv('list', '--limit', '2', '--db', ':memory:'));
    const dataLines = io.stdout.split('\n').filter((l) => l.startsWith('r') && /^r\d/.test(l));
    expect(dataLines.length).toBe(2);
  });

  it('prints "(no interrupted runs)" when empty', async () => {
    const { program, io } = build();
    await program.parseAsync(argv('list', '--db', ':memory:'));
    expect(io.stdout).toContain('no interrupted runs');
  });
});

describe('opensquid checkpoints show (commander, RAW JSONL)', () => {
  it('emits manifest + per-step checkpoint rows as JSON lines', async () => {
    const now = 100_000;
    await seed('json-run', now - 5_000);
    const { program, io } = build();
    await program.parseAsync(argv('show', 'json-run', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    const lines = io.stdout.trim().split('\n');
    expect(lines.length).toBe(2);
    const manifest = JSON.parse(lines[0] ?? '{}') as { _kind: string; runId: string };
    expect(manifest._kind).toBe('manifest');
    expect(manifest.runId).toBe('json-run');
    const cp = JSON.parse(lines[1] ?? '{}') as { _kind: string; stepIdx: number };
    expect(cp._kind).toBe('checkpoint');
    expect(cp.stepIdx).toBe(0);
  });

  it('emits checkpoints sorted by stepIdx and includes terminal marker', async () => {
    const now = 100_000;
    await seed('multi-step', now - 5_000);
    await store.append({
      runId: 'multi-step',
      stepIdx: 2,
      fn: 'op2',
      inputsHash: 'h2',
      outputs: { ok: true },
      startedAtMs: now - 4_995,
      completedAtMs: now - 4_990,
      status: 'completed',
    });
    await store.append({
      runId: 'multi-step',
      stepIdx: 1,
      fn: 'op1',
      inputsHash: 'h1',
      outputs: { ok: true },
      startedAtMs: now - 4_998,
      completedAtMs: now - 4_996,
      status: 'completed',
    });
    await store.recordRunTerminal('multi-step', 'verdict', now - 4_989);
    const { program, io } = build();
    await program.parseAsync(argv('show', 'multi-step', '--db', ':memory:'));
    const lines = io.stdout.trim().split('\n');
    expect(lines.length).toBe(5); // manifest + 3 checkpoints + terminal
    const stepIdxs = lines.slice(1, 4).map((l) => (JSON.parse(l) as { stepIdx: number }).stepIdx);
    expect(stepIdxs).toEqual([0, 1, 2]);
    const term = JSON.parse(lines[4] ?? '{}') as { _kind: string };
    expect(term._kind).toBe('terminal');
  });

  it('exit 1 + stderr message for unknown run', async () => {
    const { program, io } = build();
    const code = await withExit(() =>
      program.parseAsync(argv('show', 'ghost', '--db', ':memory:')).then(() => undefined),
    );
    expect(io.stderr).toContain('no run found for id "ghost"');
    expect(code).toBe(1);
  });
});

describe('opensquid checkpoints resume (commander)', () => {
  it('overrides DURABLE.4 60s window when called with --yes on a 24h-stale run', async () => {
    const now = 1_000_000;
    const stale = now - 24 * 60 * 60_000; // 24h ago — outside the 60s window
    await seed('stale-run', stale);
    const evaluator = vi.fn(() => Promise.resolve());
    const resumerFor = (s: CheckpointStore): Resumer =>
      new Resumer({
        store: s,
        evaluator,
        resolver: () =>
          Promise.resolve({ process: [{ call: 'op' }, { call: 'op' }], packVersion: '0.0.1' }),
        nowMs: () => now,
        // Use default 60s window — the test proves resume() bypasses it
        // regardless because Resumer.resume itself never consults the window.
      });
    const { program, io } = build({ resumerFor });
    await program.parseAsync(argv('resume', 'stale-run', '--yes', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('resumed stale-run');
    expect(evaluator).toHaveBeenCalledOnce();
  });

  it('exit 1 when manifest missing', async () => {
    const resumerFor = (s: CheckpointStore): Resumer =>
      new Resumer({
        store: s,
        evaluator: () => Promise.resolve(),
        resolver: () => Promise.resolve(null),
      });
    const { program, io } = build({ resumerFor });
    const code = await withExit(() =>
      program.parseAsync(argv('resume', 'nope', '--yes', '--db', ':memory:')).then(() => undefined),
    );
    expect(io.stderr).toContain('no manifest for runId "nope"');
    expect(code).toBe(1);
  });

  it('refuses without --yes in non-TTY context', async () => {
    await seed('any-run', 999_000);
    const { program, io } = build();
    const code = await withExit(() =>
      program.parseAsync(argv('resume', 'any-run', '--db', ':memory:')).then(() => undefined),
    );
    expect(io.stderr).toContain('refusing to resume');
    expect(code).toBe(1);
  });

  it('exit 1 when no Resumer factory is wired', async () => {
    await seed('lonely', 999_000);
    const { program, io } = build(); // no resumerFor
    const code = await withExit(() =>
      program
        .parseAsync(argv('resume', 'lonely', '--yes', '--db', ':memory:'))
        .then(() => undefined),
    );
    expect(io.stderr).toContain('manual resume requires a daemon-wired Resumer');
    expect(code).toBe(1);
  });
});

describe('opensquid checkpoints clean (commander)', () => {
  it('reports the count removed with default 30d window', async () => {
    const now = 1_000_000_000_000;
    const THIRTY_DAYS = 30 * 24 * 60 * 60_000;
    await seed('ancient', now - THIRTY_DAYS - 1_000);
    await seed('recent', now - 1_000);
    const { program, io } = build({ now: () => now });
    await program.parseAsync(argv('clean', '--yes', '--db', ':memory:'));
    expect(io.stdout).toContain('removed 1 checkpoint row');
  });

  it('honors --older-than override', async () => {
    const now = 1_000_000_000_000;
    const SEVEN_DAYS = 7 * 24 * 60 * 60_000;
    await seed('week-old', now - SEVEN_DAYS - 1_000);
    await seed('day-old', now - 24 * 60 * 60_000);
    const { program, io } = build({ now: () => now });
    await program.parseAsync(argv('clean', '--older-than', '7d', '--yes', '--db', ':memory:'));
    expect(io.stdout).toContain('removed 1 checkpoint row');
  });

  it('exit 1 on invalid --older-than', async () => {
    const { program, io } = build();
    const code = await withExit(() =>
      program
        .parseAsync(argv('clean', '--older-than', 'forever', '--yes', '--db', ':memory:'))
        .then(() => undefined),
    );
    expect(io.stderr).toContain('--older-than "forever" must be like');
    expect(code).toBe(1);
  });

  it('refuses without --yes in non-TTY context', async () => {
    const { program, io } = build();
    const code = await withExit(() =>
      program.parseAsync(argv('clean', '--db', ':memory:')).then(() => undefined),
    );
    expect(io.stderr).toContain('refusing to prune');
    expect(code).toBe(1);
  });
});

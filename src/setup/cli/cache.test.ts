/**
 * Tests for `opensquid cache` CLI verb group (CLI.7).
 *
 * Verb coverage (5+ tests):
 *   stats  — table render with HITS + SIZE columns; empty-cache
 *            placeholder text.
 *   clear  — --primitive removes only that primitive (verified via
 *            stats); --older-than removes by age; full clear with
 *            --yes works; full clear without --yes in non-TTY refuses;
 *            invalid --older-than exits 1.
 *
 * Pattern mirrors `checkpoints.test.ts`: in-memory libsql client wrapped
 * in a Proxy so the CLI's `client.close()` doesn't tear down the shared
 * connection that the test seeded; capture stdout/stderr into strings;
 * `exitOverride()` on the commander program so we can read
 * `process.exitCode` without exiting the worker.
 */

import { createClient } from '@libsql/client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoCache } from '../../runtime/durable/memo_cache.js';

import { registerCache } from './cache.js';

import type { Client } from '@libsql/client';

let client: Client;
let cache: MemoCache;
beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  cache = new MemoCache(client);
  await cache.init();
});
afterEach(() => {
  client.close();
});

function shareableClient(c: Client): Client {
  // The CLI calls client.close() in its finally block; we no-op it so
  // the test-owned connection survives across multiple verb invocations.
  return new Proxy(c, {
    get(target, prop, receiver): unknown {
      if (prop === 'close') return () => undefined;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

interface CapturedIo {
  stdout: string;
  stderr: string;
}

function build(deps: Parameters<typeof registerCache>[1] = {}): {
  program: Command;
  io: CapturedIo;
} {
  const io: CapturedIo = { stdout: '', stderr: '' };
  const program = new Command().name('opensquid').exitOverride();
  const shared = shareableClient(client);
  registerCache(program, {
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

const argv = (...args: string[]): string[] => ['node', 'cli', 'cache', ...args];

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

async function seed(fn: string, inputsHash: string, value: unknown): Promise<void> {
  await cache.set(fn, inputsHash, value);
}

describe('opensquid cache stats', () => {
  it('renders a table with PRIMITIVE / HITS / SIZE columns', async () => {
    await seed('llm_classify', 'h1', { label: 'a' });
    await seed('llm_classify', 'h2', { label: 'b' });
    await seed('recall', 'r1', []);
    const { program, io } = build();
    await program.parseAsync(argv('stats', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('PRIMITIVE');
    expect(io.stdout).toContain('HITS');
    expect(io.stdout).toContain('SIZE');
    expect(io.stdout).toContain('llm_classify');
    expect(io.stdout).toContain('recall');
    // Two llm_classify rows + zero hits each = size 2 / hits 0.
    const llmLine = io.stdout.split('\n').find((l) => l.startsWith('llm_classify'));
    expect(llmLine).toBeDefined();
    expect(llmLine).toContain('0'); // hits
    expect(llmLine).toContain('2'); // size
  });

  it('prints "(no cached primitives)" when empty', async () => {
    const { program, io } = build();
    await program.parseAsync(argv('stats', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('no cached primitives');
  });
});

describe('opensquid cache clear', () => {
  it('--primitive removes only that primitive (verified via stats)', async () => {
    await seed('llm_classify', 'h1', 1);
    await seed('llm_classify', 'h2', 2);
    await seed('recall', 'r1', 3);
    const { program, io } = build();
    await program.parseAsync(argv('clear', '--primitive', 'llm_classify', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('removed 2 cache rows');

    // Now re-stat: only `recall` should remain.
    const { program: p2, io: io2 } = build();
    await p2.parseAsync(argv('stats', '--db', ':memory:'));
    expect(io2.stdout).toContain('recall');
    expect(io2.stdout).not.toContain('llm_classify');
  });

  it('--older-than removes rows older than the window', async () => {
    // Seed two rows then advance the clock past the cutoff for one of them.
    const t0 = 1_000_000_000_000;
    const cacheClk = new MemoCache(shareableClient(client), { nowMs: () => t0 });
    await cacheClk.init();
    await cacheClk.set('llm_classify', 'old', 'O');
    // Newer row written 8 days later.
    const t1 = t0 + 8 * 24 * 60 * 60_000;
    const cacheClk2 = new MemoCache(shareableClient(client), { nowMs: () => t1 });
    await cacheClk2.set('llm_classify', 'new', 'N');

    // Clear at t1 + 1 with --older-than 7d → only `old` (8 days back) is
    // pruned; `new` (0 days back) survives. Note: the seed for `old` is at
    // t0, then at t1 we wrote `new`. Cutoff = t1 - 7d. `old.cached_at_ms`
    // (= t0) is < cutoff → removed. `new.cached_at_ms` (= t1) is not.
    const { program, io } = build({ now: () => t1 + 1 });
    await program.parseAsync(argv('clear', '--older-than', '7d', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('removed 1 cache row');
  });

  it('full clear with --yes works (no confirmation in non-TTY)', async () => {
    await seed('llm_classify', 'h1', 1);
    await seed('recall', 'r1', 2);
    const { program, io } = build();
    await program.parseAsync(argv('clear', '--yes', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('removed 2 cache rows');
  });

  it('full clear without --yes in non-TTY refuses (exit 1)', async () => {
    await seed('llm_classify', 'h1', 1);
    const { program, io } = build();
    const code = await withExit(() =>
      program.parseAsync(argv('clear', '--db', ':memory:')).then(() => undefined),
    );
    expect(io.stderr).toContain('refusing full clear without --yes in non-interactive context');
    expect(code).toBe(1);
    // Verify cache was NOT cleared.
    const { program: p2, io: io2 } = build();
    await p2.parseAsync(argv('stats', '--db', ':memory:'));
    expect(io2.stdout).toContain('llm_classify');
  });

  it('exit 1 on invalid --older-than', async () => {
    const { program, io } = build();
    const code = await withExit(() =>
      program
        .parseAsync(argv('clear', '--older-than', 'forever', '--db', ':memory:'))
        .then(() => undefined),
    );
    expect(io.stderr).toContain('--older-than "forever" must be like');
    expect(code).toBe(1);
  });

  it('selective clear with --primitive does NOT require --yes', async () => {
    await seed('llm_classify', 'h1', 1);
    const { program, io } = build();
    // No --yes, non-TTY context — selective filter means no confirmation.
    await program.parseAsync(argv('clear', '--primitive', 'llm_classify', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('removed 1 cache row');
  });
});

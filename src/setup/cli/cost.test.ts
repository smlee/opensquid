/**
 * Tests for `opensquid cost` CLI verb group (CLI.8).
 *
 * Verb coverage (4+ tests):
 *   default (summary) — empty log placeholder, then populated table.
 *   routing           — last N decisions, newest first; --limit cap;
 *                       invalid --limit exit 1.
 *   subscriptions     — reads ~/.opensquid/config.yaml; empty config
 *                       placeholder; populated pools table.
 *
 * Pattern mirrors `cache.test.ts`: in-memory libsql client wrapped in a
 * Proxy so the CLI's `client.close()` doesn't tear down the shared
 * connection. Stdout/stderr captured into strings; `exitOverride()` on
 * the commander program.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerCost } from './cost.js';
import { CostRoutingLog } from './cost_state.js';

import type { Client } from '@libsql/client';

let client: Client;
let log: CostRoutingLog;
beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  log = new CostRoutingLog(client);
  await log.init();
});
afterEach(() => {
  client.close();
});

function shareableClient(c: Client): Client {
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

function build(): {
  program: Command;
  io: CapturedIo;
} {
  const io: CapturedIo = { stdout: '', stderr: '' };
  const program = new Command().name('opensquid').exitOverride();
  const shared = shareableClient(client);
  registerCost(program, {
    openClient: () => shared,
    stdout: (s) => {
      io.stdout += s;
    },
    stderr: (s) => {
      io.stderr += s;
    },
    now: () => 1_700_000_000_000,
  });
  return { program, io };
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'cost', ...args];

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

describe('opensquid cost (default summary)', () => {
  it('prints a placeholder when the routing log is empty', async () => {
    const { program, io } = build();
    await program.parseAsync(argv('--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('no cost routing decisions yet');
  });

  it('aggregates pool usage by (tier, alias) when populated', async () => {
    await log.append({ occurredAtMs: 1, tier: 'cheap', alias: 'gemini', success: true });
    await log.append({ occurredAtMs: 2, tier: 'cheap', alias: 'gemini', success: true });
    await log.append({ occurredAtMs: 3, tier: 'cheap', alias: 'ollama', success: true });
    await log.append({ occurredAtMs: 4, tier: 'premium', alias: 'opus', success: true });
    const { program, io } = build();
    await program.parseAsync(argv('--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('TIER');
    expect(io.stdout).toContain('ALIAS');
    expect(io.stdout).toContain('PICKS');
    const geminiLine = io.stdout.split('\n').find((l) => l.includes('gemini'));
    expect(geminiLine).toBeDefined();
    expect(geminiLine).toContain('2');
    const opusLine = io.stdout.split('\n').find((l) => l.includes('opus'));
    expect(opusLine).toContain('1');
  });
});

describe('opensquid cost routing', () => {
  it('prints the last N routing decisions newest-first', async () => {
    await log.append({ occurredAtMs: 1, tier: 'cheap', alias: 'gemini', success: true });
    await log.append({ occurredAtMs: 2, tier: 'balanced', alias: 'sonnet', success: true });
    await log.append({
      occurredAtMs: 3,
      tier: 'premium',
      alias: null,
      success: false,
      reason: 'empty_tier',
    });
    const { program, io } = build();
    await program.parseAsync(argv('routing', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('TIMESTAMP');
    expect(io.stdout).toContain('STATUS');
    expect(io.stdout).toContain('picked');
    expect(io.stdout).toContain('failed');
    expect(io.stdout).toContain('empty_tier');
    // Newest first: premium (failed) should appear before cheap/gemini.
    const lines = io.stdout.split('\n');
    const premiumIdx = lines.findIndex((l) => l.includes('premium'));
    const cheapIdx = lines.findIndex((l) => l.includes('cheap'));
    expect(premiumIdx).toBeGreaterThan(0);
    expect(cheapIdx).toBeGreaterThan(premiumIdx);
  });

  it('--limit caps result count', async () => {
    for (let i = 1; i <= 5; i++) {
      await log.append({ occurredAtMs: i, tier: 'cheap', alias: `a${String(i)}`, success: true });
    }
    const { program, io } = build();
    await program.parseAsync(argv('routing', '--limit', '2', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    // Header line + 2 data lines = 3 non-empty lines.
    const dataLines = io.stdout.split('\n').filter((l) => l.length > 0);
    expect(dataLines.length).toBe(3);
  });

  it('exit 1 on invalid --limit', async () => {
    const { program, io } = build();
    const code = await withExit(() =>
      program
        .parseAsync(argv('routing', '--limit', 'abc', '--db', ':memory:'))
        .then(() => undefined),
    );
    expect(io.stderr).toContain('--limit "abc" must be a positive integer');
    expect(code).toBe(1);
  });

  it('placeholder when no routing decisions exist', async () => {
    const { program, io } = build();
    await program.parseAsync(argv('routing', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('no cost routing decisions yet');
  });
});

describe('opensquid cost subscriptions', () => {
  it('prints placeholder when config.yaml is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osq-cost-'));
    const cfg = join(dir, 'config.yaml');
    const { program, io } = build();
    await program.parseAsync(argv('subscriptions', '--config', cfg));
    expect(io.stdout).toContain('no subscription pools configured');
    expect(io.stderr).toContain('declare `subscription_pools:`');
  });

  it('lists configured pools per tier from config.yaml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'osq-cost-'));
    const cfg = join(dir, 'config.yaml');
    await writeFile(
      cfg,
      `subscription_pools:
  cheap:
    - { alias: gemini, provider: google, model: gemini-flash }
    - { alias: ollama, provider: ollama, model: qwen3 }
  premium:
    - { alias: opus, provider: anthropic, model: claude-opus-4-7 }
`,
      'utf8',
    );
    const { program, io } = build();
    await program.parseAsync(argv('subscriptions', '--config', cfg));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('TIER');
    expect(io.stdout).toContain('PROVIDER');
    expect(io.stdout).toContain('gemini');
    expect(io.stdout).toContain('opus');
    expect(io.stdout).toContain('google');
    expect(io.stdout).toContain('anthropic');
  });
});

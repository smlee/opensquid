/**
 * Tests for `opensquid limits` CLI verb group (CLI.8).
 *
 * Verb coverage (3+ tests):
 *   default — per-pack per-trigger budget table (max + used + remaining).
 *             Empty packs dir → placeholder.
 *   reset   — clears bucket rows for a pack (verified via subsequent
 *             read); requires --yes; non-TTY without --yes refuses
 *             with exit 1.
 *
 * Pack fixtures live under a tmpdir packs/ so the manifest schema is
 * exercised end-to-end. RateLimiter buckets are seeded by direct INSERT
 * into the in-memory libsql so we don't reach into RateLimiter internals.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerLimits } from './limits.js';

import type { Client } from '@libsql/client';

let client: Client;
beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  await client.execute(`
    CREATE TABLE rate_limit_buckets (
      pack_id TEXT NOT NULL,
      trigger_kind TEXT NOT NULL,
      key TEXT NOT NULL,
      tokens REAL NOT NULL,
      last_refill_ms INTEGER NOT NULL,
      concurrent_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (pack_id, trigger_kind, key)
    );
  `);
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

function build(opts: { isTty?: boolean } = {}): {
  program: Command;
  io: CapturedIo;
} {
  const io: CapturedIo = { stdout: '', stderr: '' };
  const program = new Command().name('opensquid').exitOverride();
  const shared = shareableClient(client);
  registerLimits(program, {
    openClient: () => shared,
    stdout: (s) => {
      io.stdout += s;
    },
    stderr: (s) => {
      io.stderr += s;
    },
    isTty: () => opts.isTty === true,
  });
  return { program, io };
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'limits', ...args];

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

async function writeManifestPack(
  packsDir: string,
  packId: string,
  rateLimitsYaml: string,
): Promise<void> {
  const dir = join(packsDir, packId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'manifest.yaml'),
    `name: ${packId}
version: 0.1.0
scope: project
goal: test pack for limits CLI
${rateLimitsYaml}
`,
    'utf8',
  );
}

async function seedBucket(
  packId: string,
  triggerKind: string,
  key: string,
  tokens: number,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO rate_limit_buckets (pack_id, trigger_kind, key, tokens, last_refill_ms, concurrent_count)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [packId, triggerKind, key, tokens, 0, 0],
  });
}

describe('opensquid limits (default)', () => {
  it('renders a per-pack per-trigger budget table joining caps with buckets', async () => {
    const packs = await mkdtemp(join(tmpdir(), 'osq-limits-'));
    await writeManifestPack(
      packs,
      'ci-monitor',
      `rate_limits:
  schedule: { max: 10, per: minute }
  webhook: { max: 100, per: hour }`,
    );
    // Bucket says we've consumed 3 of the 10 schedule tokens.
    await seedBucket('ci-monitor', 'schedule', 'ci-monitor::schedule', 7);
    // Webhook bucket untouched → CLI shows max=100 used=0 remaining=100.
    const { program, io } = build();
    await program.parseAsync(argv('--packs-dir', packs, '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('PACK');
    expect(io.stdout).toContain('TRIGGER');
    expect(io.stdout).toContain('MAX');
    expect(io.stdout).toContain('USED');
    expect(io.stdout).toContain('REMAINING');
    const schedLine = io.stdout.split('\n').find((l) => l.includes('schedule'));
    expect(schedLine).toBeDefined();
    expect(schedLine).toContain('10'); // max
    expect(schedLine).toContain('3'); // used (10 - 7)
    expect(schedLine).toContain('7'); // remaining
    const hookLine = io.stdout.split('\n').find((l) => l.includes('webhook'));
    expect(hookLine).toContain('100'); // max
    expect(hookLine).toContain('0'); // used
  });

  it('prints placeholder when no packs declare rate_limits', async () => {
    const packs = await mkdtemp(join(tmpdir(), 'osq-limits-'));
    await writeManifestPack(packs, 'no-limits-pack', '');
    const { program, io } = build();
    await program.parseAsync(argv('--packs-dir', packs, '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('no pack-declared rate limits');
  });
});

describe('opensquid limits reset', () => {
  it('clears bucket rows for a pack with --yes (verified via subsequent read)', async () => {
    const packs = await mkdtemp(join(tmpdir(), 'osq-limits-'));
    await writeManifestPack(
      packs,
      'ci-monitor',
      `rate_limits:
  schedule: { max: 10, per: minute }`,
    );
    await seedBucket('ci-monitor', 'schedule', 'ci-monitor::schedule', 4);
    await seedBucket('ci-monitor', 'schedule', 'other-key', 2);

    // Reset with --yes.
    const { program: p1, io: io1 } = build();
    await p1.parseAsync(argv('reset', 'ci-monitor', '--yes', '--db', ':memory:'));
    expect(io1.stderr).toBe('');
    expect(io1.stdout).toContain('reset 2 bucket rows for "ci-monitor"');

    // Verify via default verb: bucket cleared → max + 0 used.
    const { program: p2, io: io2 } = build();
    await p2.parseAsync(argv('--packs-dir', packs, '--db', ':memory:'));
    const schedLine = io2.stdout.split('\n').find((l) => l.includes('schedule'));
    expect(schedLine).toBeDefined();
    expect(schedLine).toContain('10'); // max
    expect(schedLine).toContain('0'); // used (no bucket row = full)
  });

  it('refuses with exit 1 in non-TTY without --yes', async () => {
    await seedBucket('ci-monitor', 'schedule', 'k', 5);
    const { program, io } = build(); // isTty defaults false
    const code = await withExit(() =>
      program.parseAsync(argv('reset', 'ci-monitor', '--db', ':memory:')).then(() => undefined),
    );
    expect(io.stderr).toContain(
      'refusing to reset "ci-monitor" without --yes in non-interactive context',
    );
    expect(code).toBe(1);

    // Verify bucket was NOT cleared.
    const rs = await client.execute('SELECT COUNT(*) AS n FROM rate_limit_buckets');
    expect(Number((rs.rows[0] as Record<string, unknown>).n)).toBe(1);
  });

  it('reset on a pack with no bucket rows reports 0', async () => {
    const { program, io } = build();
    await program.parseAsync(argv('reset', 'phantom-pack', '--yes', '--db', ':memory:'));
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('reset 0 bucket rows for "phantom-pack"');
  });
});

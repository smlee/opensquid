/**
 * Tests for `opensquid audit` CLI (CLI.5).
 *
 * Six surfaces:
 *
 *   1. `list` default — newest 20.
 *   2. `shell` / `channels` / `pending` — category narrowing.
 *   3. `--since` / `--decision` / `--limit` filters.
 *   4. `approve <id>` / `reject <id>` round-trip + race-safe exit codes.
 *   5. `tail` AbortController cleanup (no leaked SIGINT listener).
 *   6. Error paths: bad --since, bad --decision, bad --category, bad id.
 */

import { createClient } from '@libsql/client';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog } from '../../runtime/audit_log.js';

import { registerAudit } from './audit.js';

import type { Client } from '@libsql/client';

let client: Client;
let log: AuditLog;

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  log = new AuditLog(client);
  await log.init();
});

afterEach(() => {
  client.close();
});

interface CapturedIo {
  stdout: string;
  stderr: string;
}

/**
 * Wrap the in-memory libsql client with a no-op `close()` so multiple verb
 * invocations against the SAME client can share a connection. (The verb
 * implementation closes the client in its finally block — fine in prod
 * where every CLI invocation is a fresh process, but breaks tests that
 * drive two verbs against the same `:memory:` DB.)
 */
function shareableClient(c: Client): Client {
  return new Proxy(c, {
    get(target, prop, receiver): unknown {
      if (prop === 'close') return () => undefined;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function buildProgram(deps: { client: Client; abort?: AbortController; now?: () => number }): {
  program: Command;
  io: CapturedIo;
} {
  const io: CapturedIo = { stdout: '', stderr: '' };
  const program = new Command().name('opensquid').exitOverride();
  const shared = shareableClient(deps.client);
  registerAudit(program, {
    openClient: () => shared,
    stdout: (s) => {
      io.stdout += s;
    },
    stderr: (s) => {
      io.stderr += s;
    },
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.abort !== undefined ? { abort: deps.abort } : {}),
  });
  return { program, io };
}

async function seedFiveDenied(): Promise<void> {
  const baseMs = Date.now() - 30 * 60_000; // 30m ago
  for (let i = 0; i < 5; i += 1) {
    await log.append({
      occurredAtMs: baseMs + i * 1000,
      category: 'capability_gate',
      decision: 'denied',
      packId: 'ci',
      detail: { capability: 'shell_exec', target: `cmd-${String(i)}` },
    });
  }
}

describe('opensquid audit (default list)', () => {
  it('renders recent entries as JSON', async () => {
    await seedFiveDenied();
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', '--db', ':memory:'], { from: 'user' });
    expect(io.stderr).toBe('');
    const parsed = JSON.parse(io.stdout) as { entries: { category: string }[] };
    expect(parsed.entries).toHaveLength(5);
    for (const e of parsed.entries) expect(e.category).toBe('capability_gate');
  });

  it('empty store prints "(no audit entries match the query)"', async () => {
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', '--db', ':memory:'], { from: 'user' });
    expect(io.stdout).toContain('no audit entries match the query');
  });

  it('--since narrows to recent window', async () => {
    await seedFiveDenied();
    // Add a 2h-old row that should be filtered out.
    await log.append({
      occurredAtMs: Date.now() - 2 * 60 * 60_000,
      category: 'capability_gate',
      decision: 'denied',
      detail: { capability: 'shell_exec', target: 'old-cmd' },
    });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', '--db', ':memory:', '--since', '1h'], { from: 'user' });
    const parsed = JSON.parse(io.stdout) as { entries: { detail: { target: string } }[] };
    expect(parsed.entries).toHaveLength(5);
    for (const e of parsed.entries) expect(e.detail.target).not.toBe('old-cmd');
  });

  it('--decision narrows to one verdict', async () => {
    await log.append({
      occurredAtMs: Date.now() - 60_000,
      category: 'capability_gate',
      decision: 'allowed',
      detail: {},
    });
    await log.append({
      occurredAtMs: Date.now() - 60_000,
      category: 'capability_gate',
      decision: 'denied',
      detail: {},
    });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', '--db', ':memory:', '--decision', 'allowed'], {
      from: 'user',
    });
    const parsed = JSON.parse(io.stdout) as { entries: { decision: string }[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.decision).toBe('allowed');
  });

  it('--decision invalid → exit 1', async () => {
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', '--db', ':memory:', '--decision', 'wat'], { from: 'user' });
    expect(io.stderr).toContain('--decision "wat" must be one of');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });

  it('--since invalid → exit 1', async () => {
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', '--db', ':memory:', '--since', 'forever'], { from: 'user' });
    expect(io.stderr).toContain('--since "forever" must be like');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });

  it('--category invalid → exit 1', async () => {
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', '--db', ':memory:', '--category', 'unknown'], {
      from: 'user',
    });
    expect(io.stderr).toContain('--category "unknown" must be one of');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });
});

describe('opensquid audit pending — queue', () => {
  it('prints "(no pending approvals)" when queue empty', async () => {
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'pending', '--db', ':memory:'], { from: 'user' });
    expect(io.stdout).toContain('no pending approvals');
  });

  it('returns only pending_shell decision=prompted rows', async () => {
    await log.append({
      occurredAtMs: Date.now(),
      category: 'pending_shell',
      decision: 'prompted',
      packId: 'ci',
      detail: { command: 'pnpm test' },
    });
    await log.append({
      occurredAtMs: Date.now(),
      category: 'pending_shell',
      decision: 'approved',
      packId: 'ci',
      detail: { command: 'pnpm lint' },
    });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'pending', '--db', ':memory:'], { from: 'user' });
    const parsed = JSON.parse(io.stdout) as { pending: { decision: string }[] };
    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending[0]?.decision).toBe('prompted');
  });
});

describe('opensquid audit approve / reject — atomic transition', () => {
  it('approve <id> transitions prompted → approved', async () => {
    await log.append({
      occurredAtMs: Date.now(),
      category: 'pending_shell',
      decision: 'prompted',
      detail: { command: 'pnpm test' },
    });
    const [row] = await log.query({ category: 'pending_shell', decision: 'prompted' });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'approve', String(row!.id), '--db', ':memory:'], {
      from: 'user',
    });
    const parsed = JSON.parse(io.stdout) as { transitioned: { id: number; to: string } };
    expect(parsed.transitioned.to).toBe('approved');
    expect(parsed.transitioned.id).toBe(row!.id);
  });

  it('reject <id> transitions prompted → rejected', async () => {
    await log.append({
      occurredAtMs: Date.now(),
      category: 'pending_shell',
      decision: 'prompted',
      detail: { command: 'rm -rf /' },
    });
    const [row] = await log.query({ category: 'pending_shell', decision: 'prompted' });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'reject', String(row!.id), '--db', ':memory:'], {
      from: 'user',
    });
    const parsed = JSON.parse(io.stdout) as { transitioned: { id: number; to: string } };
    expect(parsed.transitioned.to).toBe('rejected');
  });

  it('approve nonexistent id → exit 1 with clean message', async () => {
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'approve', '99999', '--db', ':memory:'], { from: 'user' });
    expect(io.stderr).toContain('no pending row with id=99999');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });

  it('approve invalid id syntax → exit 1', async () => {
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'approve', 'not-a-number', '--db', ':memory:'], {
      from: 'user',
    });
    expect(io.stderr).toContain('invalid id "not-a-number"');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });

  it('double-approve same id → second invocation exits 1 (already resolved)', async () => {
    await log.append({
      occurredAtMs: Date.now(),
      category: 'pending_shell',
      decision: 'prompted',
      detail: { command: 'pnpm test' },
    });
    const [row] = await log.query({ category: 'pending_shell', decision: 'prompted' });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'approve', String(row!.id), '--db', ':memory:'], {
      from: 'user',
    });
    expect(io.stdout).toContain('"to": "approved"');
    // Second approve attempt.
    const prior = process.exitCode;
    process.exitCode = 0;
    const { program: program2, io: io2 } = buildProgram({ client });
    await program2.parseAsync(['audit', 'approve', String(row!.id), '--db', ':memory:'], {
      from: 'user',
    });
    expect(io2.stderr).toContain('already resolved or never existed');
    expect(process.exitCode).toBe(1);
    process.exitCode = prior;
  });
});

describe('opensquid audit shell / channels — category narrowing', () => {
  it('shell returns only pending_shell rows', async () => {
    await log.append({
      occurredAtMs: Date.now(),
      category: 'pending_shell',
      decision: 'prompted',
      detail: { command: 'pnpm test' },
    });
    await log.append({
      occurredAtMs: Date.now(),
      category: 'webhook',
      decision: 'allowed',
      detail: {},
    });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'shell', '--db', ':memory:'], { from: 'user' });
    const parsed = JSON.parse(io.stdout) as { entries: { category: string }[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.category).toBe('pending_shell');
  });

  it('channels returns only channel_send rows', async () => {
    await log.append({
      occurredAtMs: Date.now(),
      category: 'channel_send',
      decision: 'success',
      detail: { abstractChannel: 'alerts', sent: 1, failed: 0 },
    });
    await log.append({
      occurredAtMs: Date.now(),
      category: 'webhook',
      decision: 'allowed',
      detail: {},
    });
    const { program, io } = buildProgram({ client });
    await program.parseAsync(['audit', 'channels', '--db', ':memory:'], { from: 'user' });
    const parsed = JSON.parse(io.stdout) as { entries: { category: string }[] };
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.category).toBe('channel_send');
  });
});

describe('opensquid audit tail --follow — AbortController cleanup', () => {
  it('SIGINT-equivalent abort exits cleanly with no leaked listener', async () => {
    const abort = new AbortController();
    const { program } = buildProgram({ client, abort });
    // Abort before parseAsync — the tail loop sees aborted on first iteration.
    abort.abort();
    const before = process.listenerCount('SIGINT');
    await program.parseAsync(
      ['audit', 'tail', '--db', ':memory:', '--follow', '--interval', '100'],
      { from: 'user' },
    );
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });

  it('tail without --follow returns the first batch and exits', async () => {
    // Seed a row stamped FAR in the future so the cursor sees it on first poll.
    const farFuture = Date.now() + 24 * 60 * 60_000;
    await log.append({
      occurredAtMs: farFuture,
      category: 'capability_gate',
      decision: 'allowed',
      detail: { i: 'first' },
    });
    const abort = new AbortController();
    const before = process.listenerCount('SIGINT');
    const { program, io } = buildProgram({
      client,
      abort,
      now: () => farFuture - 1,
    });
    await program.parseAsync(['audit', 'tail', '--db', ':memory:', '--interval', '100'], {
      from: 'user',
    });
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
    expect(io.stdout).toContain('capability_gate');
    expect(io.stdout).toContain('allowed');
  });
});

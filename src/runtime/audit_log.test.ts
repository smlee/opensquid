/**
 * Tests for the unified `AuditLog` (CLI.5).
 *
 * Five test surfaces:
 *
 *   1. `init` is idempotent — repeated calls don't re-create the table.
 *   2. `append` + `query` round-trip every category.
 *   3. `query` honors `sinceMs` + `category` + `decision` + `limit`.
 *   4. `tail` polling — AbortController exits the loop cleanly.
 *   5. `transitionPending` — single-row-wins atomicity for two concurrent
 *      transitions; non-existent / already-resolved rows return false.
 *
 * Index-usage assertion (acceptance criterion #5) is in test surface #6:
 *   EXPLAIN QUERY PLAN confirms `idx_audit_occurred_category` is used.
 */

import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLog, hashDetailValue } from './audit_log.js';

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

describe('AuditLog.init', () => {
  it('is idempotent — repeated calls succeed', async () => {
    await log.init();
    await log.init();
    // Table existence — INFORMATION_SCHEMA equivalent in SQLite is sqlite_master.
    const rs = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'",
    );
    expect(rs.rows).toHaveLength(1);
  });

  it('creates the (category, occurred_at_ms) index', async () => {
    const rs = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_audit_occurred_category'",
    );
    expect(rs.rows).toHaveLength(1);
  });
});

describe('AuditLog.append + query — every category round-trips', () => {
  it('capability_gate', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'capability_gate',
      decision: 'allowed',
      packId: 'ci',
      detail: { capability: 'shell_exec', target: 'pnpm test', source: 'declared' },
    });
    const rows = await log.query({ category: 'capability_gate' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail.capability).toBe('shell_exec');
  });

  it('webhook with hashed secret', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'webhook',
      decision: 'denied',
      detail: {
        event: 'rejected_hmac',
        subscriptionId: 'sub-1',
        // Secret is hashed at the producer — never raw in detail.
        secretHash: hashDetailValue('topsecret'),
      },
    });
    const rows = await log.query({ category: 'webhook' });
    expect(rows[0]?.detail.secretHash).toBe(hashDetailValue('topsecret'));
    expect(rows[0]?.detail.secretHash).not.toBe('topsecret');
  });

  it('schedule', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'schedule',
      decision: 'success',
      packId: 'cron-pack',
      detail: { cronExpr: '*/5 * * * *', runId: 'r1' },
    });
    const rows = await log.query({ category: 'schedule' });
    expect(rows[0]?.detail.cronExpr).toBe('*/5 * * * *');
  });

  it('resume', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'resume',
      decision: 'success',
      detail: { runId: 'abc123', fromStepIdx: 3, reason: 'restart' },
    });
    const rows = await log.query({ category: 'resume' });
    expect(rows[0]?.detail.runId).toBe('abc123');
  });

  it('channel_send', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'channel_send',
      decision: 'success',
      packId: 'alerter',
      detail: { abstractChannel: 'alerts', scheme: 'telegram', sent: 1, failed: 0 },
    });
    const rows = await log.query({ category: 'channel_send' });
    expect(rows[0]?.detail.abstractChannel).toBe('alerts');
  });

  it('channel_inbound (Patch B — AUTO.6 inbound router category)', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'channel_inbound',
      decision: 'success',
      packId: 'support',
      detail: { event_subtype: 'inbound_dispatched', channel: 'alerts', sender: 'user-7' },
    });
    const rows = await log.query({ category: 'channel_inbound' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail.event_subtype).toBe('inbound_dispatched');
    expect(rows[0]?.packId).toBe('support');
  });

  it('pending_shell starts in prompted state', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'pending_shell',
      decision: 'prompted',
      packId: 'ci',
      detail: { command: 'rm -rf node_modules', queuedAtMs: 1_700_000_000_000 },
    });
    const rows = await log.query({ category: 'pending_shell', decision: 'prompted' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe('prompted');
  });
});

describe('AuditLog.query — filters', () => {
  beforeEach(async () => {
    for (let i = 0; i < 10; i += 1) {
      await log.append({
        occurredAtMs: 1_700_000_000_000 + i * 1000,
        category: i % 2 === 0 ? 'capability_gate' : 'webhook',
        decision: i % 3 === 0 ? 'denied' : 'allowed',
        detail: { i },
      });
    }
  });

  it('--since filters by occurred_at_ms cutoff', async () => {
    const rows = await log.query({ sinceMs: 1_700_000_000_000 + 5000 });
    // Rows i=5..9 → 5 rows.
    expect(rows).toHaveLength(5);
  });

  it('--category narrows to one variant', async () => {
    const rows = await log.query({ category: 'webhook' });
    // i odd → 5 rows.
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.category).toBe('webhook');
  });

  it('--decision narrows to one verdict', async () => {
    const rows = await log.query({ decision: 'denied' });
    // i ∈ {0, 3, 6, 9} → 4 rows.
    expect(rows).toHaveLength(4);
  });

  it('--limit caps the result set', async () => {
    const rows = await log.query({ limit: 3 });
    expect(rows).toHaveLength(3);
  });

  it('orders newest-first by occurred_at_ms DESC', async () => {
    const rows = await log.query({ limit: 100 });
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1]!.occurredAtMs).toBeGreaterThanOrEqual(rows[i]!.occurredAtMs);
    }
  });
});

describe('AuditLog.tail — polling iterator', () => {
  it('yields rows landed after the cursor; exits on signal.aborted', async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    await log.append({
      occurredAtMs: farFuture,
      category: 'capability_gate',
      decision: 'allowed',
      detail: { i: 1 },
    });
    const controller = new AbortController();
    const stream = await log.tail({
      sinceMs: farFuture - 1,
      intervalMs: 100,
      signal: controller.signal,
    });
    const collected: number[] = [];
    for await (const row of stream) {
      collected.push(Number(row.detail.i));
      controller.abort();
      break;
    }
    expect(collected).toEqual([1]);
    expect(controller.signal.aborted).toBe(true);
  });

  it('exits immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = await log.tail({
      sinceMs: 0,
      intervalMs: 100,
      signal: controller.signal,
    });
    const collected: unknown[] = [];
    for await (const row of stream) collected.push(row);
    expect(collected).toEqual([]);
  });

  it('honors category filter in tail', async () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    await log.append({
      occurredAtMs: farFuture,
      category: 'webhook',
      decision: 'allowed',
      detail: { i: 'w' },
    });
    await log.append({
      occurredAtMs: farFuture + 1,
      category: 'capability_gate',
      decision: 'allowed',
      detail: { i: 'c' },
    });
    const controller = new AbortController();
    const stream = await log.tail({
      sinceMs: farFuture - 1,
      intervalMs: 100,
      signal: controller.signal,
      category: 'capability_gate',
    });
    const collected: string[] = [];
    for await (const row of stream) {
      collected.push(String(row.detail.i));
      controller.abort();
      break;
    }
    expect(collected).toEqual(['c']);
  });
});

describe('AuditLog.transitionPending — atomic single-winner', () => {
  it('prompted → approved succeeds, returns true', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'pending_shell',
      decision: 'prompted',
      detail: { command: 'pnpm test' },
    });
    const [row] = await log.query({ category: 'pending_shell', decision: 'prompted' });
    expect(row).toBeDefined();
    const ok = await log.transitionPending(row!.id, 'approved');
    expect(ok).toBe(true);
    const updated = await log.query({ category: 'pending_shell' });
    expect(updated[0]?.decision).toBe('approved');
  });

  it('two concurrent transitions: exactly one wins (rowsAffected === 1)', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'pending_shell',
      decision: 'prompted',
      detail: { command: 'pnpm test' },
    });
    const [row] = await log.query({ category: 'pending_shell', decision: 'prompted' });
    // Two concurrent transitions on the same id. SQLite serializes single
    // UPDATEs; the second sees decision !== 'prompted' and modifies 0 rows.
    const [a, b] = await Promise.all([
      log.transitionPending(row!.id, 'approved'),
      log.transitionPending(row!.id, 'rejected'),
    ]);
    expect([a, b].filter((x) => x).length).toBe(1);
    const updated = await log.query({ category: 'pending_shell' });
    // Final state is either approved OR rejected — never both, never prompted.
    expect(['approved', 'rejected']).toContain(updated[0]?.decision);
  });

  it('non-existent id returns false', async () => {
    const ok = await log.transitionPending(99_999, 'approved');
    expect(ok).toBe(false);
  });

  it('already-resolved row returns false', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'pending_shell',
      decision: 'prompted',
      detail: {},
    });
    const [row] = await log.query({ category: 'pending_shell', decision: 'prompted' });
    expect(await log.transitionPending(row!.id, 'approved')).toBe(true);
    // Second transition on the same row fails (it's no longer 'prompted').
    expect(await log.transitionPending(row!.id, 'rejected')).toBe(false);
  });

  it('refuses to transition rows from a non-pending_shell category', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'capability_gate',
      decision: 'prompted',
      detail: {},
    });
    const [row] = await log.query({ category: 'capability_gate' });
    const ok = await log.transitionPending(row!.id, 'approved');
    expect(ok).toBe(false);
  });
});

describe('AuditLog — index usage (acceptance criterion: sub-100ms / 1M rows)', () => {
  it('EXPLAIN QUERY PLAN uses idx_audit_occurred_category for (category, sinceMs) queries', async () => {
    await log.append({
      occurredAtMs: 1_700_000_000_000,
      category: 'capability_gate',
      decision: 'allowed',
      detail: {},
    });
    const rs = await client.execute(
      `EXPLAIN QUERY PLAN
       SELECT id, occurred_at_ms, category, decision, pack_id, skill, rule_id, detail_json
       FROM audit_log
       WHERE category = 'capability_gate' AND occurred_at_ms >= 1700000000000
       ORDER BY occurred_at_ms DESC, id DESC
       LIMIT 20`,
    );
    const plan = rs.rows
      .map((r) => {
        const d = (r as Record<string, unknown>).detail;
        return typeof d === 'string' ? d : '';
      })
      .join(' | ');
    // SQLite emits "SEARCH audit_log USING INDEX idx_audit_occurred_category" — fail
    // on the FULL-SCAN equivalent ("SCAN audit_log" without an index).
    expect(plan).toContain('idx_audit_occurred_category');
    expect(plan).not.toMatch(/SCAN audit_log(?!\s+USING)/);
  });
});

describe('hashDetailValue', () => {
  it('produces a stable 16-char hex digest', () => {
    const a = hashDetailValue('secret');
    const b = hashDetailValue('secret');
    const c = hashDetailValue('different');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is not invertible (deterministic, but not reversible)', () => {
    const hashed = hashDetailValue('topsecret');
    expect(hashed).not.toContain('topsecret');
  });
});

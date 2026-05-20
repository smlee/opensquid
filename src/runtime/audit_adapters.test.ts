/**
 * Tests for audit producer → unified `AuditLog` adapters (Patch B).
 *
 * Per-adapter round-trip: construct an `AuditLog` over libsql `:memory:`,
 * acquire the adapter sink, fire each producer-specific event variant,
 * verify the persisted row matches the locked (category, decision, detail)
 * mapping. ≥3 tests per adapter; ≥12 total.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  adaptCapabilityGate,
  adaptInboundRouter,
  adaptResumer,
  adaptWebhookServer,
} from './audit_adapters.js';
import { AuditLog } from './audit_log.js';

import type { CapabilityRequest, CapabilityVerdict } from './capability_gate.js';
import type { WebhookAuditEntry } from './webhook_server.js';
import type { AuditEntry as ResumerAuditEntry } from './durable/resumer.js';
import type { InboundRouterAuditEntry } from '../channels/inbound_router.js';

let client: Client;
let log: AuditLog;
let nowMs: number;
const now = (): number => nowMs;

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  log = new AuditLog(client);
  await log.init();
  nowMs = 1_700_000_000_000;
});

afterEach(() => {
  client.close();
});

/** Tick the injected clock and return the new value. */
function tick(by = 1): number {
  nowMs += by;
  return nowMs;
}

/** Small helper: wait for the next macrotask so fire-and-forget
 *  `auditLog.append` (an async DB write) lands before we query. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('adaptCapabilityGate', () => {
  it('allowed verdict → category=capability_gate, decision=allowed, packId+detail preserved', async () => {
    const sink = adaptCapabilityGate(log, now);
    const req: CapabilityRequest = {
      pack: 'ci',
      capability: 'shell_exec',
      target: 'pnpm test',
    };
    const verdict: CapabilityVerdict = {
      allowed: true,
      source: 'declared',
      message: 'shell allowlist exact: "pnpm test"',
    };
    sink(verdict, req);
    await flush();
    const [row] = await log.query({ category: 'capability_gate' });
    expect(row).toBeDefined();
    expect(row?.category).toBe('capability_gate');
    expect(row?.decision).toBe('allowed');
    expect(row?.packId).toBe('ci');
    expect(row?.detail).toMatchObject({
      event_subtype: 'declared',
      capability: 'shell_exec',
      target: 'pnpm test',
      source: 'declared',
      message: 'shell allowlist exact: "pnpm test"',
    });
  });

  it('denied verdict → decision=denied, source=denylist preserved', async () => {
    const sink = adaptCapabilityGate(log, now);
    sink(
      { allowed: false, source: 'denylist', message: 'built-in shell deny: matches rm -rf' },
      { pack: 'evil', capability: 'shell_exec', target: 'rm -rf /' },
    );
    await flush();
    const [row] = await log.query({ category: 'capability_gate' });
    expect(row?.decision).toBe('denied');
    expect(row?.detail.source).toBe('denylist');
    expect(row?.detail.event_subtype).toBe('denylist');
    expect(row?.packId).toBe('evil');
  });

  it('http_request → method preserved in detail', async () => {
    const sink = adaptCapabilityGate(log, now);
    sink(
      {
        allowed: true,
        source: 'user_override',
        message: 'user override: api.github.com matches "*.github.com"',
      },
      {
        pack: 'fetcher',
        capability: 'http_request',
        target: 'https://api.github.com/repos',
        method: 'GET',
      },
    );
    await flush();
    const [row] = await log.query({ category: 'capability_gate' });
    expect(row?.detail.method).toBe('GET');
    expect(row?.detail.capability).toBe('http_request');
    expect(row?.detail.source).toBe('user_override');
  });

  it('uses injected clock', async () => {
    const sink = adaptCapabilityGate(log, now);
    nowMs = 1_800_000_000_000;
    sink(
      { allowed: true, source: 'declared' },
      { pack: 'p', capability: 'file_write', target: '/tmp/x.txt' },
    );
    await flush();
    const [row] = await log.query({ category: 'capability_gate' });
    expect(row?.occurredAtMs).toBe(1_800_000_000_000);
  });
});

describe('adaptWebhookServer', () => {
  it('received → decision=success', async () => {
    const sink = adaptWebhookServer(log, now);
    const entry: WebhookAuditEntry = {
      event: 'received',
      subscriptionId: 'sub-1',
      receivedAt: '2026-05-20T00:00:00.000Z',
    };
    sink(entry);
    await flush();
    const [row] = await log.query({ category: 'webhook' });
    expect(row?.decision).toBe('success');
    expect(row?.detail.event_subtype).toBe('received');
    expect(row?.detail.subscriptionId).toBe('sub-1');
    expect(row?.detail.receivedAt).toBe('2026-05-20T00:00:00.000Z');
  });

  it('rejected_hmac → decision=denied', async () => {
    const sink = adaptWebhookServer(log, now);
    sink({
      event: 'rejected_hmac',
      subscriptionId: 'sub-2',
      receivedAt: '2026-05-20T00:00:00.000Z',
    });
    await flush();
    const [row] = await log.query({ category: 'webhook' });
    expect(row?.decision).toBe('denied');
    expect(row?.detail.event_subtype).toBe('rejected_hmac');
  });

  it('all 4 rejected_* variants → denied', async () => {
    const sink = adaptWebhookServer(log, now);
    const events: WebhookAuditEntry[] = [
      { event: 'rejected_method', method: 'GET', receivedAt: 't' },
      { event: 'rejected_unknown', subscriptionId: 's', receivedAt: 't' },
      { event: 'rejected_hmac', subscriptionId: 's', receivedAt: 't' },
      { event: 'rejected_rate_limit', subscriptionId: 's', receivedAt: 't' },
    ];
    for (const e of events) {
      tick();
      sink(e);
    }
    await flush();
    const rows = await log.query({ category: 'webhook' });
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.decision).toBe('denied');
  });

  it('idempotent + deliver_only + dispatched → success', async () => {
    const sink = adaptWebhookServer(log, now);
    sink({ event: 'idempotent', subscriptionId: 's', receivedAt: 't' });
    tick();
    sink({ event: 'deliver_only', subscriptionId: 's', receivedAt: 't', rendered: true });
    tick();
    sink({ event: 'dispatched', subscriptionId: 's', receivedAt: 't' });
    await flush();
    const rows = await log.query({ category: 'webhook' });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.decision).toBe('success');
  });

  it('error → decision=error, reason preserved', async () => {
    const sink = adaptWebhookServer(log, now);
    sink({ event: 'error', reason: 'EHOSTUNREACH', receivedAt: 't' });
    await flush();
    const [row] = await log.query({ category: 'webhook' });
    expect(row?.decision).toBe('error');
    expect(row?.detail.reason).toBe('EHOSTUNREACH');
    expect(row?.detail.event_subtype).toBe('error');
  });

  it('packId is undefined (webhook is daemon-level)', async () => {
    const sink = adaptWebhookServer(log, now);
    sink({ event: 'received', subscriptionId: 's', receivedAt: 't' });
    await flush();
    const [row] = await log.query({ category: 'webhook' });
    expect(row?.packId).toBeUndefined();
  });
});

describe('adaptResumer', () => {
  it('resume_run → category=resume, decision=success, packId set', async () => {
    const sink = adaptResumer(log, now);
    const entry: ResumerAuditEntry = {
      event: 'resume_run',
      runId: 'r1',
      packId: 'pack-A',
      fromStepIdx: 3,
    };
    sink(entry);
    await flush();
    const [row] = await log.query({ category: 'resume' });
    expect(row?.category).toBe('resume');
    expect(row?.decision).toBe('success');
    expect(row?.packId).toBe('pack-A');
    expect(row?.detail.event_subtype).toBe('resume_run');
    expect(row?.detail.runId).toBe('r1');
    expect(row?.detail.fromStepIdx).toBe(3);
  });

  it('resume_skipped (pack_missing) → decision=success, reason in detail', async () => {
    const sink = adaptResumer(log, now);
    sink({ event: 'resume_skipped', runId: 'r2', reason: 'pack_missing' });
    await flush();
    const [row] = await log.query({ category: 'resume' });
    expect(row?.decision).toBe('success');
    expect(row?.detail.event_subtype).toBe('resume_skipped');
    expect(row?.detail.reason).toBe('pack_missing');
    expect(row?.packId).toBeUndefined();
  });

  it('resume_summary → decision=success, totals preserved', async () => {
    const sink = adaptResumer(log, now);
    sink({ event: 'resume_summary', scanned: 5, resumed: 3, skippedOther: 2 });
    await flush();
    const [row] = await log.query({ category: 'resume' });
    expect(row?.decision).toBe('success');
    expect(row?.detail.event_subtype).toBe('resume_summary');
    expect(row?.detail.scanned).toBe(5);
    expect(row?.detail.resumed).toBe(3);
    expect(row?.detail.skippedOther).toBe(2);
  });

  it('resume_skipped (evaluator_error) → still success at audit level; reason discriminates', async () => {
    const sink = adaptResumer(log, now);
    sink({
      event: 'resume_skipped',
      runId: 'r3',
      reason: 'evaluator_error',
      detail: 'TypeError: cannot read x',
    });
    await flush();
    const [row] = await log.query({ category: 'resume' });
    expect(row?.decision).toBe('success');
    expect(row?.detail.reason).toBe('evaluator_error');
    expect(row?.detail.detail).toBe('TypeError: cannot read x');
  });
});

describe('adaptInboundRouter', () => {
  it('inbound_dispatched → category=channel_inbound, decision=success, packId set', async () => {
    const sink = adaptInboundRouter(log, now);
    const entry: InboundRouterAuditEntry = {
      event: 'inbound_dispatched',
      pack: 'support',
      channel: 'alerts',
      uri: 'telegram://chat/123',
      sender: 'user-7',
    };
    sink(entry);
    await flush();
    const [row] = await log.query({ category: 'channel_inbound' });
    expect(row?.category).toBe('channel_inbound');
    expect(row?.decision).toBe('success');
    expect(row?.packId).toBe('support');
    expect(row?.detail.event_subtype).toBe('inbound_dispatched');
    expect(row?.detail.sender).toBe('user-7');
    expect(row?.detail.uri).toBe('telegram://chat/123');
  });

  it('inbound_sender_denied → decision=denied', async () => {
    const sink = adaptInboundRouter(log, now);
    sink({
      event: 'inbound_sender_denied',
      pack: 'support',
      channel: 'alerts',
      sender: 'spammer-99',
      reason: 'pack-local deny',
    });
    await flush();
    const [row] = await log.query({ category: 'channel_inbound' });
    expect(row?.decision).toBe('denied');
    expect(row?.detail.event_subtype).toBe('inbound_sender_denied');
    expect(row?.detail.sender).toBe('spammer-99');
    expect(row?.detail.reason).toBe('pack-local deny');
  });

  it('inbound_no_adapter + inbound_unmapped + inbound_adapter_not_inboundable + inbound_dispatch_error → decision=error', async () => {
    const sink = adaptInboundRouter(log, now);
    const events: InboundRouterAuditEntry[] = [
      { event: 'inbound_no_adapter', pack: 'p', channel: 'c', scheme: 'foo' },
      { event: 'inbound_unmapped', pack: 'p', channel: 'c' },
      {
        event: 'inbound_adapter_not_inboundable',
        pack: 'p',
        channel: 'c',
        uri: 'http://x',
        scheme: 'http',
      },
      {
        event: 'inbound_dispatch_error',
        pack: 'p',
        channel: 'c',
        sender: 's',
        reason: 'boom',
      },
    ];
    for (const e of events) {
      tick();
      sink(e);
    }
    await flush();
    const rows = await log.query({ category: 'channel_inbound' });
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.decision).toBe('error');
  });

  it('inbound_subscribed → decision=success', async () => {
    const sink = adaptInboundRouter(log, now);
    sink({
      event: 'inbound_subscribed',
      pack: 'p',
      channel: 'alerts',
      uri: 'telegram://chat/1',
      scheme: 'telegram',
    });
    await flush();
    const [row] = await log.query({ category: 'channel_inbound' });
    expect(row?.decision).toBe('success');
    expect(row?.detail.event_subtype).toBe('inbound_subscribed');
  });

  it('does NOT leak the abstract channel into the indexed packId column', async () => {
    // Sanity: `pack` lifts to `packId`; `channel` stays inside detail.
    const sink = adaptInboundRouter(log, now);
    sink({
      event: 'inbound_dispatched',
      pack: 'support',
      channel: 'alerts',
      uri: 'telegram://chat/1',
      sender: 'u',
    });
    await flush();
    const [row] = await log.query({ category: 'channel_inbound' });
    expect(row?.packId).toBe('support');
    expect(row?.detail.channel).toBe('alerts');
  });
});

describe('audit_adapters — single-direction dependency invariants', () => {
  it('producers do not import AuditLog (negative-import check via static text)', async () => {
    // Heuristic: read each producer source and verify the unified
    // `audit_log` module is NEVER referenced. The adapter module is the
    // only allowed coupling.
    const root = path.resolve(__dirname, '..', '..');
    const sources = [
      'src/runtime/capability_gate.ts',
      'src/runtime/webhook_server.ts',
      'src/runtime/durable/resumer.ts',
      'src/channels/inbound_router.ts',
    ];
    for (const rel of sources) {
      const text = await readFile(path.resolve(root, rel), 'utf8');
      expect(text, `${rel} must not import the unified audit_log module`).not.toMatch(
        /from\s+['"][^'"]*audit_log(\.js)?['"]/,
      );
    }
  });
});

/**
 * Tests for `OpenSquidDaemon` — singleton, cron registration, webhook
 * binding, SIGTERM cleanup.
 *
 * Strategy:
 *   - Per-test OPENSQUID_HOME via `mkdtemp` so daemon.lock + daemon.pid
 *     live in an isolated dir.
 *   - Webhook port `0` (kernel-assigned) so parallel tests don't collide.
 *   - Cron schedules use the standard 5-field shape; we don't fake-tick
 *     node-cron internally — we test "is the cron task created and
 *     started" + "node-cron.validate passes". The fire-time path is
 *     covered separately via `fireScheduleEntry` exposure-by-behaviour
 *     (a unit test that invokes the same path through registered task
 *     name lookup). Avoiding `vi.useFakeTimers` here because node-cron
 *     pulls in setImmediate-based scheduling that interacts poorly with
 *     vi's timer mocks.
 *
 * Coverage:
 *   1. start() registers one cron task per schedule entry; webhook server binds.
 *   2. start() throws on invalid cron in pack (registry refuses early).
 *   3. Singleton: second start() in same OPENSQUID_HOME → throws.
 *   4. stop() halts all tasks, closes server, releases lock — under 5s.
 *   5. SIGTERM emit calls stop() and finishes within 5s budget.
 *   6. PID file written on start, removed on stop.
 *   7. dispatch is called on a manual fire (entry executor wrapping path).
 *   8. status() reports running + uptime > 0 while running; not-running after stop.
 *   9. Rate-limit denial on schedule fire: dispatch NOT called, audit logged.
 *  10. Audit log never contains a webhook signing secret value.
 *  11. status() returns running with the pid file when read out-of-process.
 */

import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenSquidDaemon, type DaemonAuditEntry } from './daemon.js';
import type { AuditEntry as ResumerAuditEntry } from './durable/resumer.js';
import type { Event } from './event.js';
import { daemonLockPath, daemonPidPath } from './paths.js';
import type { RateLimiter } from './rate_limit.js';
import type { Pack } from './types.js';
import type { Subscription } from './webhook_subscriptions.js';

const FIVE_SECONDS_MS = 5_000;

function pack(name: string, skills: Pack['skills']): Pack {
  return {
    name,
    version: '0.0.1',
    scope: 'project',
    goal: 'test',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills,
  };
}

function scheduleSkill(name: string, cronExpr: string): Pack['skills'][number] {
  return {
    name,
    load: 'lazy',
    when_to_load: [],
    unloads_when: [],
    triggers: [{ kind: 'schedule', cron: cronExpr }],
    rules: [],
  };
}

function subscription(id: string, secret = 'k'): Subscription {
  return {
    id,
    pack: 'p',
    skill: 's',
    signingSecret: secret,
    deliverOnly: false,
  };
}

// Per-test sandbox.
let tmpRoot: string;
let priorHome: string | undefined;
const daemons: OpenSquidDaemon[] = [];

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tmpRoot = await mkdtemp(join(tmpdir(), 'opensquid-daemon-test-'));
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  // Stop any leftover daemon so the lock releases before we rm the tmp dir.
  while (daemons.length > 0) {
    const d = daemons.pop();
    if (!d) break;
    await d.stop().catch(() => undefined);
  }
  if (priorHome === undefined) {
    delete process.env.OPENSQUID_HOME;
  } else {
    process.env.OPENSQUID_HOME = priorHome;
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

function newDaemon(opts: ConstructorParameters<typeof OpenSquidDaemon>[0]): OpenSquidDaemon {
  const d = new OpenSquidDaemon(opts);
  daemons.push(d);
  return d;
}

describe('OpenSquidDaemon — start / stop', () => {
  it('registers cron entries and binds the webhook server', async () => {
    const events: Event[] = [];
    const d = newDaemon({
      packs: [pack('p1', [scheduleSkill('s1', '*/5 * * * *')])],
      subscriptions: [subscription('hook1')],
      webhookPort: 0,
      dispatch: (e) => {
        events.push(e);
        return Promise.resolve();
      },
    });
    await d.start();
    expect(d.scheduleEntries()).toHaveLength(1);
    expect(d.scheduleEntries()[0]?.cron).toBe('*/5 * * * *');
    expect(d.webhookBoundPort()).toBeGreaterThan(0);
    const status = await d.status();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    await d.stop();
  });

  it('refuses to start when a pack has an invalid cron', async () => {
    const d = newDaemon({
      packs: [pack('bad', [scheduleSkill('s', 'not even cron')])],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await expect(d.start()).rejects.toThrow(/cron/);
    // Lock must not have been acquired; subsequent start with a good
    // config succeeds.
    const ok = newDaemon({
      packs: [pack('ok', [scheduleSkill('s', '0 9 * * *')])],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await expect(ok.start()).resolves.toBeUndefined();
    await ok.stop();
  });

  it('throws on second start while another daemon holds the lock', async () => {
    const first = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await first.start();
    const second = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await expect(second.start()).rejects.toThrow(/already running/);
    await first.stop();
  });

  it('writes a pid file on start and removes it on stop', async () => {
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    const pidRaw = await readFile(daemonPidPath(), 'utf8');
    expect(Number.parseInt(pidRaw, 10)).toBe(process.pid);
    await d.stop();
    await expect(stat(daemonPidPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stop() finishes within 5 seconds and releases the lock', async () => {
    const d = newDaemon({
      packs: [pack('p', [scheduleSkill('s', '*/1 * * * *')])],
      subscriptions: [subscription('h1'), subscription('h2')],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    const t0 = Date.now();
    await d.stop();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(FIVE_SECONDS_MS);
    // Lock dir must be gone so a fresh daemon can boot.
    const refresh = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await expect(refresh.start()).resolves.toBeUndefined();
    await refresh.stop();
  });

  it('handles a SIGTERM emit by stopping within 5s', async () => {
    const d = newDaemon({
      packs: [pack('p', [scheduleSkill('s', '*/1 * * * *')])],
      subscriptions: [subscription('h1')],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    const t0 = Date.now();
    process.emit('SIGTERM');
    // Poll for stop completion (signal handler is async).
    while (Date.now() - t0 < FIVE_SECONDS_MS) {
      const status = await d.status();
      if (!status.running) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const final = await d.status();
    expect(final.running).toBe(false);
    expect(Date.now() - t0).toBeLessThan(FIVE_SECONDS_MS);
  });
});

describe('OpenSquidDaemon — dispatch + audit', () => {
  it('schedule entries dispatch via the rate-limit-aware fire path', async () => {
    const events: Event[] = [];
    const audit: DaemonAuditEntry[] = [];
    const d = newDaemon({
      packs: [pack('p1', [scheduleSkill('s1', '*/5 * * * *')])],
      subscriptions: [],
      webhookPort: 0,
      auditLog: (e) => audit.push(e),
      dispatch: (e) => {
        events.push(e);
        return Promise.resolve();
      },
    });
    await d.start();
    const entry = d.scheduleEntries()[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    await d.fireEntryForTest(entry.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('schedule');
    if (events[0]?.kind === 'schedule') {
      expect(events[0].scheduleId).toBe(entry.id);
      expect(events[0].fireTime).toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
    expect(audit.some((e) => e.event === 'schedule_fired')).toBe(true);
    await d.stop();
  });

  it('rate-limit denial on schedule fire blocks dispatch + audits', async () => {
    const events: Event[] = [];
    const audit: DaemonAuditEntry[] = [];
    const denyingLimiter: Partial<RateLimiter> = {
      check: () => Promise.resolve({ allowed: false, reason: 'rate_exceeded' }),
    };
    const d = newDaemon({
      packs: [pack('p1', [scheduleSkill('s1', '*/5 * * * *')])],
      subscriptions: [],
      webhookPort: 0,
      rateLimiter: denyingLimiter as RateLimiter,
      auditLog: (e) => audit.push(e),
      dispatch: (e) => {
        events.push(e);
        return Promise.resolve();
      },
    });
    await d.start();
    const entry = d.scheduleEntries()[0];
    expect(entry).toBeDefined();
    if (!entry) return;
    await d.fireEntryForTest(entry.id);
    expect(events).toHaveLength(0);
    expect(audit.some((e) => e.event === 'schedule_rate_limited')).toBe(true);
    await d.stop();
  });

  it('audit log never contains a webhook signing secret', async () => {
    const SECRET = 'TOP-SECRET-VALUE-NEVER-LOG';
    const audit: DaemonAuditEntry[] = [];
    const d = newDaemon({
      packs: [],
      subscriptions: [subscription('h1', SECRET)],
      webhookPort: 0,
      auditLog: (e) => audit.push(e),
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    // Round-trip the audit array through JSON to assert string content.
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    await d.stop();
  });
});

describe('OpenSquidDaemon — status reader', () => {
  it('reports not-running when no pid file exists', async () => {
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    const status = await d.status();
    expect(status.running).toBe(false);
  });

  it('reports running via pid file when daemon is in idle state but pid file exists', async () => {
    // Simulate an out-of-process status read: write a pid file directly,
    // then ask a freshly-constructed daemon (state=idle) for status.
    const { writeFile } = await import('node:fs/promises');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpRoot), { recursive: true });
    await writeFile(daemonPidPath(), '99999', 'utf8');
    const reader = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    const status = await reader.status();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(99999);
  });

  it('cleans up the lock dir between runs', async () => {
    const lockPath = daemonLockPath();
    const d1 = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await d1.start();
    await d1.stop();
    await expect(stat(`${lockPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------
// DURABLE.4 — restart-safe resume hook
// ---------------------------------------------------------------------------

describe('OpenSquidDaemon — DURABLE.4 resumer hook', () => {
  // Minimal Resumer-shaped stub. We cast to satisfy the `resumer?: Resumer`
  // field without depending on the full Resumer class graph here — the
  // daemon only invokes resumeOnStartup() on it.
  interface ResumerStub {
    resumeOnStartup: () => Promise<{ resumed: number; skipped: number }>;
  }
  const makeStubResumer = (
    rs: ResumerStub,
  ): NonNullable<Parameters<typeof newDaemon>[0]['resumer']> =>
    rs as unknown as NonNullable<Parameters<typeof newDaemon>[0]['resumer']>;

  it('invokes resumer.resumeOnStartup() after lock acquire + before cron registration', async () => {
    const order: string[] = [];
    const resumer = makeStubResumer({
      resumeOnStartup: () => {
        order.push('resume');
        return Promise.resolve({ resumed: 0, skipped: 0 });
      },
    });
    const d = newDaemon({
      packs: [pack('p', [scheduleSkill('s', '*/5 * * * *')])],
      subscriptions: [],
      webhookPort: 0,
      resumer,
      dispatch: () => {
        order.push('dispatch');
        return Promise.resolve();
      },
    });
    await d.start();
    // Resume fires during start(); we never see 'dispatch' here because
    // cron didn't tick. Order so far: ['resume'].
    expect(order).toEqual(['resume']);
    await d.stop();
  });

  it('still enforces singleton even when crashed-run data is present', async () => {
    // Simulate a prior crash: pretend resumer would see interrupted work.
    // Even so, the SECOND daemon must fail to acquire the lock.
    const resumer = makeStubResumer({
      resumeOnStartup: () => Promise.resolve({ resumed: 2, skipped: 0 }),
    });
    const first = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      resumer,
      dispatch: () => Promise.resolve(),
    });
    await first.start();
    const second = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      resumer,
      dispatch: () => Promise.resolve(),
    });
    await expect(second.start()).rejects.toThrow(/already running/);
    await first.stop();
  });

  it('start() rollback fires when resumer throws (lock + pid file released)', async () => {
    const resumer = makeStubResumer({
      resumeOnStartup: () => Promise.reject(new Error('resumer boom')),
    });
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      resumer,
      dispatch: () => Promise.resolve(),
    });
    await expect(d.start()).rejects.toThrow(/resumer boom/);
    // After rollback, a fresh daemon must be able to boot.
    const refresh = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await expect(refresh.start()).resolves.toBeUndefined();
    await refresh.stop();
  });
});

// ---------------------------------------------------------------------------
// Patch C — daemon owns the unified `AuditLog` lifecycle
// ---------------------------------------------------------------------------

/** Wait one microtask + setImmediate so any `void auditLog.append(...)`
 *  promises queued by the adapter fan-out actually resolve before we
 *  query the libsql client. Mirrors `audit_adapters.test.ts:flush`. */
async function flushAudit(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('OpenSquidDaemon — Patch C unified AuditLog lifecycle', () => {
  it('start() opens + init AuditLog; stop() releases the daemon-owned client', async () => {
    const audit: Client = createClient({ url: ':memory:' });
    // Inject the client; daemon must NOT close it on stop (ownership = caller).
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      auditClient: audit,
      dispatch: () => Promise.resolve(),
    });
    expect(d.getAuditLog()).toBeNull();
    await d.start();
    const log = d.getAuditLog();
    expect(log).not.toBeNull();
    // init() created the audit_log table — assert via sqlite_master.
    const rs = await audit.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'",
    );
    expect(rs.rows).toHaveLength(1);
    await d.stop();
    expect(d.getAuditLog()).toBeNull();
    // Caller-injected client must still be usable — daemon didn't close it.
    const rs2 = await audit.execute('SELECT COUNT(*) AS c FROM audit_log');
    expect(rs2.rows).toHaveLength(1);
    audit.close();
  });

  it('webhook accept lands in the unified audit_log table via the daemon', async () => {
    const audit: Client = createClient({ url: ':memory:' });
    const SECRET = 'hook-secret-1';
    const d = newDaemon({
      packs: [],
      subscriptions: [
        {
          id: 'wh-accept',
          pack: 'p',
          skill: 's',
          signingSecret: SECRET,
          deliverOnly: false,
        },
      ],
      webhookPort: 0,
      auditClient: audit,
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    const port = d.webhookBoundPort();
    expect(port).toBeGreaterThan(0);
    const body = JSON.stringify({ patch: 'C' });
    const res = await fetch(`http://127.0.0.1:${String(port)}/webhook/wh-accept`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign(SECRET, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    await flushAudit();
    const log = d.getAuditLog();
    expect(log).not.toBeNull();
    if (!log) return;
    const rows = await log.query({ category: 'webhook' });
    // received + dispatched both land in the unified table.
    const subtypes = rows.map((r) => r.detail.event_subtype);
    expect(subtypes).toContain('received');
    expect(subtypes).toContain('dispatched');
    // Discipline: the signing secret never reaches the unified log.
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    await d.stop();
    audit.close();
  });

  it('resumer events fan out into the unified audit_log table', async () => {
    const audit: Client = createClient({ url: ':memory:' });
    // Resumer-shaped stub with `attachAuditSink` so the daemon can fan-out.
    type AttachedSink = (entry: ResumerAuditEntry) => void;
    const attached: AttachedSink[] = [];
    const resumerStub = {
      attachAuditSink: (sink: AttachedSink) => {
        attached.push(sink);
      },
      resumeOnStartup: (): Promise<{ resumed: number; skipped: number }> => {
        // Emit one resume_run + one resume_summary through every attached sink.
        for (const s of attached) {
          s({
            event: 'resume_run',
            runId: 'r-patch-c',
            packId: 'pack-Z',
            fromStepIdx: 2,
          });
          s({ event: 'resume_summary', scanned: 1, resumed: 1, skippedOther: 0 });
        }
        return Promise.resolve({ resumed: 1, skipped: 0 });
      },
    };
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      auditClient: audit,
      resumer: resumerStub as unknown as NonNullable<Parameters<typeof newDaemon>[0]['resumer']>,
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    await flushAudit();
    const log = d.getAuditLog();
    expect(log).not.toBeNull();
    if (!log) return;
    const rows = await log.query({ category: 'resume' });
    const subtypes = rows.map((r) => r.detail.event_subtype).sort();
    expect(subtypes).toEqual(['resume_run', 'resume_summary']);
    const runRow = rows.find((r) => r.detail.event_subtype === 'resume_run');
    expect(runRow?.packId).toBe('pack-Z');
    expect(runRow?.decision).toBe('success');
    await d.stop();
    audit.close();
  });

  it('getAuditLog(): null → instance → null across start/stop lifecycle', async () => {
    const audit: Client = createClient({ url: ':memory:' });
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      auditClient: audit,
      dispatch: () => Promise.resolve(),
    });
    expect(d.getAuditLog()).toBeNull();
    await d.start();
    expect(d.getAuditLog()).not.toBeNull();
    await d.stop();
    expect(d.getAuditLog()).toBeNull();
    audit.close();
  });

  it('caller-provided auditClient is NOT closed by daemon.stop() (ownership boundary)', async () => {
    const audit: Client = createClient({ url: ':memory:' });
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      auditClient: audit,
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    await d.stop();
    // If the daemon had closed it, this would throw — `@libsql/client`'s
    // memory backend rejects execute() on a closed client.
    const rs = await audit.execute('SELECT 1 AS x');
    expect(rs.rows[0]?.x).toBe(1);
    audit.close();
  });

  it('daemon-owned auditClient is opened from OPENSQUID_HOME and persists across stop()', async () => {
    // No auditClient → daemon opens its own at OPENSQUID_HOME/opensquid.db.
    // Verify the file appears + the daemon's getAuditLog populates rows.
    const d = newDaemon({
      packs: [],
      subscriptions: [],
      webhookPort: 0,
      dispatch: () => Promise.resolve(),
    });
    await d.start();
    const log = d.getAuditLog();
    expect(log).not.toBeNull();
    if (!log) return;
    await log.append({
      occurredAtMs: Date.now(),
      category: 'webhook',
      decision: 'success',
      detail: { marker: 'patch-c-owned' },
    });
    await d.stop();
    // After daemon.stop() the daemon-owned client is closed (and the
    // AuditLog instance is null) — re-open from disk and confirm the
    // row survived the close.
    const dbPath = join(tmpRoot, 'opensquid.db');
    await expect(stat(dbPath)).resolves.toBeDefined();
    const reopen: Client = createClient({ url: `file:${dbPath}` });
    const rs = await reopen.execute(
      "SELECT detail_json FROM audit_log WHERE detail_json LIKE '%patch-c-owned%'",
    );
    expect(rs.rows).toHaveLength(1);
    reopen.close();
  });
});

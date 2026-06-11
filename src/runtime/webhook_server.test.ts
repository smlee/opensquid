/**
 * Tests for `WebhookServer` — HMAC verify, idempotency, rate-limit, 404/405.
 *
 * We bind on `127.0.0.1:0` (kernel-assigned port) so parallel tests don't
 * collide. Each test creates + closes a fresh server; the `afterEach`
 * sweeps any leftover instance.
 *
 * Coverage:
 *   1. valid HMAC → 200 + dispatch called with parsed WebhookEvent.
 *   2. invalid HMAC → 401, no dispatch.
 *   3. missing signature header → 401.
 *   4. malformed signature header → 401 (sha256= prefix check).
 *   5. duplicate POST same body within window → 200 + idempotent flag, no dispatch.
 *   6. duplicate POST after TTL expiry → 200 + dispatch fires again.
 *   7. unknown subscription id → 404.
 *   8. wrong HTTP method (GET) → 405.
 *   9. rate-limit denial → 429 with Retry-After header.
 *  10. close() drains gracefully; no leftover timer keeps process alive.
 */

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import type { RateLimiter } from './rate_limit.js';
import type { WebhookEvent } from './event.js';
import type { Subscription } from './webhook_subscriptions.js';
import { WebhookServer } from './webhook_server.js';

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const FIXED_SECRET = 'super-secret-key';

function makeSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'stripe-events',
    pack: 'billing',
    skill: 'router',
    signingSecret: FIXED_SECRET,
    deliverOnly: false,
    ...overrides,
  };
}

interface ServerHandle {
  server: WebhookServer;
  url: string;
  dispatched: WebhookEvent[];
}

const handles: ServerHandle[] = [];

async function startServer(
  opts: Partial<ConstructorParameters<typeof WebhookServer>[0]> = {},
  subscriptions: Subscription[] = [makeSubscription()],
): Promise<ServerHandle> {
  const dispatched: WebhookEvent[] = [];
  const server = new WebhookServer({
    port: 0,
    host: '127.0.0.1',
    subscriptions,
    dispatch: (e) => {
      dispatched.push(e);
      return Promise.resolve();
    },
    ...opts,
  });
  await server.start();
  const addr = server.address();
  if (!addr) throw new Error('server failed to bind');
  const handle: ServerHandle = {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    dispatched,
  };
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (!h) break;
    await h.server.close().catch(() => undefined);
  }
});

describe('WebhookServer — HMAC', () => {
  it('accepts a valid signature and dispatches a WebhookEvent', async () => {
    const h = await startServer();
    const body = JSON.stringify({ hello: 'world' });
    const res = await fetch(`${h.url}/webhook/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign(FIXED_SECRET, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { accepted: boolean; subscriptionId: string };
    expect(json.accepted).toBe(true);
    expect(json.subscriptionId).toBe('stripe-events');
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.kind).toBe('webhook');
    expect(h.dispatched[0]?.subscriptionId).toBe('stripe-events');
    expect(h.dispatched[0]?.body).toEqual({ hello: 'world' });
  });

  it('rejects an invalid signature with 401 and no dispatch', async () => {
    const h = await startServer();
    const body = JSON.stringify({ tampered: true });
    const res = await fetch(`${h.url}/webhook/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign('WRONG-SECRET', body),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(h.dispatched).toHaveLength(0);
  });

  it('rejects a missing signature header with 401', async () => {
    const h = await startServer();
    const res = await fetch(`${h.url}/webhook/stripe-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(h.dispatched).toHaveLength(0);
  });

  it('rejects a signature without the sha256= prefix', async () => {
    const h = await startServer();
    const body = '{}';
    const rawHex = createHmac('sha256', FIXED_SECRET).update(body).digest('hex');
    const res = await fetch(`${h.url}/webhook/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': rawHex, // missing `sha256=` prefix
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe('WebhookServer — idempotency', () => {
  it('dedups duplicate POST same body within TTL window', async () => {
    const nowMs = 1_000_000;
    const h = await startServer({ now: () => nowMs, idempotencyTtlMs: 60_000 });
    const body = JSON.stringify({ event: 'charge.succeeded', id: 'evt_1' });
    const sig = sign(FIXED_SECRET, body);
    const post = () =>
      fetch(`${h.url}/webhook/stripe-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-opensquid-signature': sig },
        body,
      });
    const res1 = await post();
    expect(res1.status).toBe(200);
    expect(((await res1.json()) as { accepted?: boolean }).accepted).toBe(true);
    expect(h.dispatched).toHaveLength(1);
    // Within window — same body should be deduped.
    const res2 = await post();
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { idempotent?: boolean }).idempotent).toBe(true);
    expect(h.dispatched).toHaveLength(1);
  });

  it('re-dispatches duplicate POST after TTL window expires', async () => {
    let nowMs = 1_000_000;
    const h = await startServer({ now: () => nowMs, idempotencyTtlMs: 60_000 });
    const body = JSON.stringify({ event: 'charge.succeeded', id: 'evt_2' });
    const sig = sign(FIXED_SECRET, body);
    const post = () =>
      fetch(`${h.url}/webhook/stripe-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-opensquid-signature': sig },
        body,
      });
    await post();
    expect(h.dispatched).toHaveLength(1);
    nowMs += 70_000; // jump past TTL
    await post();
    expect(h.dispatched).toHaveLength(2);
  });
});

describe('WebhookServer — routing + method', () => {
  it('returns 404 for unknown subscription id', async () => {
    const h = await startServer();
    const res = await fetch(`${h.url}/webhook/does-not-exist`, {
      method: 'POST',
      body: '{}',
      headers: { 'x-opensquid-signature': sign(FIXED_SECRET, '{}') },
    });
    expect(res.status).toBe(404);
  });

  it('returns 405 for non-POST methods', async () => {
    const h = await startServer();
    const res = await fetch(`${h.url}/webhook/stripe-events`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('returns 404 for non-webhook paths', async () => {
    const h = await startServer();
    const res = await fetch(`${h.url}/random`, { method: 'POST', body: '' });
    expect(res.status).toBe(404);
  });
});

describe('WebhookServer — rate-limit', () => {
  it('returns 429 with Retry-After when limiter denies', async () => {
    const limiter: Partial<RateLimiter> = {
      check: () =>
        Promise.resolve({ allowed: false, retryAfterMs: 5000, reason: 'rate_exceeded' as const }),
    };
    const sub = makeSubscription({ rateLimit: { max: 1, per: 'minute' } });
    const h = await startServer({ rateLimiter: limiter as RateLimiter }, [sub]);
    const body = '{"x":1}';
    const res = await fetch(`${h.url}/webhook/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign(FIXED_SECRET, body),
      },
      body,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(h.dispatched).toHaveLength(0);
  });

  // FAC.1 (wg-8f7d9b919a40): the concurrent slot acquired by an allowed
  // check() is RELEASED on every post-check exit — a counting stub limiter
  // pins check/release pairing across the dispatch path, the idempotent
  // short-circuit, and the denied path (no release without acquisition).
  it('releases the slot after dispatch AND after the idempotent short-circuit; never on denial', async () => {
    let checks = 0;
    let releases = 0;
    let allow = true;
    const limiter: Partial<RateLimiter> = {
      check: () => {
        checks += 1;
        return Promise.resolve(
          allow ? { allowed: true } : { allowed: false, reason: 'concurrent_exceeded' as const },
        );
      },
      release: () => {
        releases += 1;
        return Promise.resolve();
      },
    };
    const sub = makeSubscription({ rateLimit: { max: 100, per: 'minute' } });
    const h = await startServer({ rateLimiter: limiter as RateLimiter }, [sub]);
    const body = '{"x":"fac1"}';
    const headers = {
      'content-type': 'application/json',
      'x-opensquid-signature': sign(FIXED_SECRET, body),
    };

    // 1. Normal dispatch: check + release pair.
    const r1 = await fetch(`${h.url}/webhook/stripe-events`, { method: 'POST', headers, body });
    expect(r1.status).toBe(200);
    expect(checks).toBe(1);
    expect(releases).toBe(1);

    // 2. Duplicate body → idempotent short-circuit AFTER the check — the
    //    slot must still be released (the post-check early-exit class).
    const r2 = await fetch(`${h.url}/webhook/stripe-events`, { method: 'POST', headers, body });
    expect(r2.status).toBe(200);
    expect(checks).toBe(2);
    expect(releases).toBe(2);
    expect(h.dispatched).toHaveLength(1); // second was idempotent

    // 3. Denied: no slot acquired → no release.
    allow = false;
    const r3 = await fetch(`${h.url}/webhook/stripe-events`, { method: 'POST', headers, body });
    expect(r3.status).toBe(429);
    expect(checks).toBe(3);
    expect(releases).toBe(2);
  });

  it('skips rate-limit check when subscription has no rateLimit config', async () => {
    let called = false;
    const limiter: Partial<RateLimiter> = {
      check: () => {
        called = true;
        return Promise.resolve({ allowed: false });
      },
    };
    const h = await startServer({ rateLimiter: limiter as RateLimiter });
    const body = '{}';
    const res = await fetch(`${h.url}/webhook/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign(FIXED_SECRET, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(called).toBe(false);
  });
});

describe('WebhookServer — audit', () => {
  it('emits structured audit entries with NO secret values', async () => {
    const audit: Parameters<typeof startServer>[0] = {
      auditLog: () => undefined,
    };
    const entries: unknown[] = [];
    const h = await startServer({
      ...audit,
      auditLog: (e) => entries.push(e),
    });
    const body = '{}';
    await fetch(`${h.url}/webhook/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign(FIXED_SECRET, body),
      },
      body,
    });
    expect(entries.length).toBeGreaterThan(0);
    // Audit log must never contain the resolved signing secret.
    for (const e of entries) {
      expect(JSON.stringify(e)).not.toContain(FIXED_SECRET);
    }
  });
});

describe('WebhookServer — deliver-only wiring (SCHED.2)', () => {
  it('routes deliver_only=true subs through the deliverOnly handler, never dispatch', async () => {
    const sub = makeSubscription({
      id: 'github-push',
      deliverOnly: true,
      template: 'msg: {{x}}',
      deliverTo: 'alerts',
      severity: 'info',
    });
    const dispatched: WebhookEvent[] = [];
    const entries: unknown[] = [];
    const handlerCalls: { subId: string; body: unknown }[] = [];
    const server = new WebhookServer({
      port: 0,
      host: '127.0.0.1',
      subscriptions: [sub],
      dispatch: (e) => {
        dispatched.push(e);
        return Promise.resolve();
      },
      deliverOnly: (s, body) => {
        handlerCalls.push({ subId: s.id, body });
        return Promise.resolve({
          rendered: true,
          emptyFieldCount: 0,
          redactedSecrets: 0,
          multicast: { sent: 1, failed: 0 },
        });
      },
      auditLog: (e) => entries.push(e),
    });
    await server.start();
    handles.push({ server, url: `http://127.0.0.1:${server.address()!.port}`, dispatched });

    const body = JSON.stringify({ x: 'hello' });
    const res = await fetch(`http://127.0.0.1:${server.address()!.port}/webhook/github-push`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign(FIXED_SECRET, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(0);
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]?.subId).toBe('github-push');
    expect(handlerCalls[0]?.body).toEqual({ x: 'hello' });
    const deliverEntry = entries.find(
      (e): e is { event: 'deliver_only'; rendered: boolean } =>
        typeof e === 'object' && e !== null && (e as { event?: string }).event === 'deliver_only',
    );
    expect(deliverEntry).toBeDefined();
    expect(deliverEntry?.rendered).toBe(true);
  });

  it('audits deliver-only as misconfigured when no handler wired, still returns 200', async () => {
    const sub = makeSubscription({ deliverOnly: true });
    const entries: unknown[] = [];
    const server = new WebhookServer({
      port: 0,
      host: '127.0.0.1',
      subscriptions: [sub],
      dispatch: () => Promise.resolve(),
      auditLog: (e) => entries.push(e),
    });
    await server.start();
    handles.push({ server, url: `http://127.0.0.1:${server.address()!.port}`, dispatched: [] });

    const body = '{}';
    const res = await fetch(`http://127.0.0.1:${server.address()!.port}/webhook/stripe-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sign(FIXED_SECRET, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { delivered: boolean; reason?: string };
    expect(json.delivered).toBe(false);
    expect(json.reason).toBe('misconfigured');
    const deliverEntry = entries.find(
      (e): e is { event: 'deliver_only'; reason?: string } =>
        typeof e === 'object' && e !== null && (e as { event?: string }).event === 'deliver_only',
    );
    expect(deliverEntry?.reason).toBe('misconfigured');
  });
});

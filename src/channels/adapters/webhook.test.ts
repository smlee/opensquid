/**
 * Webhook adapter tests — `fetch`, `random`, and `sleep` are injected
 * via opts seams so the entire surface is deterministic without timer
 * hacks. Covers URI exact-match validation, 200 happy path, 500-then-
 * 200 retry-and-success, HMAC signature exactness against a known
 * input, signing-secret absent → no header, 4xx → no retry, signed
 * body shape contains text + severity, and secret-never-logged.
 */

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { webhookAdapter } from './webhook.js';

interface FetchCallInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface FetchCall {
  url: string;
  init: FetchCallInit | undefined;
}

function makeFetchSpy(responses: { status: number; ok?: boolean }[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const f: typeof fetch = (input, init) => {
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    const normalized: FetchCallInit | undefined =
      init === undefined ? undefined : (init as unknown as FetchCallInit);
    calls.push({ url, init: normalized });
    const r = responses[i] ?? responses[responses.length - 1];
    if (r === undefined) throw new Error('no response queued');
    i += 1;
    const status = r.status;
    const ok = r.ok ?? (status >= 200 && status < 300);
    return Promise.resolve({ ok, status } as unknown as Response);
  };
  return { f, calls };
}

let sleepCalls: number[];
let sleep: (ms: number) => Promise<void>;

beforeEach(() => {
  sleepCalls = [];
  sleep = (ms: number): Promise<void> => {
    sleepCalls.push(ms);
    return Promise.resolve();
  };
});

describe('webhookAdapter — URI validation', () => {
  it('matches exact webhook://<name> only', () => {
    const a = webhookAdapter({ name: 'alerts', url: 'https://example.com/hook' });
    expect(a.validate('webhook://alerts')).toBe(true);
    expect(a.validate('webhook://other')).toBe(false);
    expect(a.validate('webhook://alerts/extra')).toBe(false);
    expect(a.validate('webhook://')).toBe(false);
    expect(a.validate('https://example.com/hook')).toBe(false);
  });
});

describe('webhookAdapter — send() happy path', () => {
  it('POSTs JSON body and returns ok on 200', async () => {
    const { f, calls } = makeFetchSpy([{ status: 200 }]);
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://example.com/hook',
      fetch: f,
      sleep,
    });
    const r = await a.send('webhook://alerts', { text: 'fire', severity: 'warning' });
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.com/hook');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers?.['content-type']).toBe('application/json');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ text: 'fire', severity: 'warning' }));
    expect(sleepCalls).toEqual([]);
  });

  it('rejects mismatched URI without calling fetch', async () => {
    const { f, calls } = makeFetchSpy([{ status: 200 }]);
    const a = webhookAdapter({ name: 'alerts', url: 'https://x.com', fetch: f, sleep });
    const r = await a.send('webhook://other', { text: 'x' });
    expect(r).toEqual({ ok: false, error: 'bad uri' });
    expect(calls).toHaveLength(0);
  });
});

describe('webhookAdapter — retry policy', () => {
  it('retries on 500 then succeeds on 200; backoff is jittered', async () => {
    const { f, calls } = makeFetchSpy([{ status: 500 }, { status: 200 }]);
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      fetch: f,
      sleep,
      random: () => 0.5, // deterministic jitter for the assertion
    });
    const r = await a.send('webhook://alerts', { text: 'x' });
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    // attempt 0 backoff = 100 + floor(0.5 * 50) = 125
    expect(sleepCalls).toEqual([125]);
  });

  it('retries 5xx up to MAX_ATTEMPTS then returns the last status', async () => {
    const { f, calls } = makeFetchSpy([{ status: 503 }, { status: 502 }, { status: 500 }]);
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      fetch: f,
      sleep,
      random: () => 0,
    });
    const r = await a.send('webhook://alerts', { text: 'x' });
    expect(r).toEqual({ ok: false, error: 'webhook 500' });
    expect(calls).toHaveLength(3);
    // Two backoffs (between attempts), not three. Base * 2^i with zero
    // jitter → 100, 200.
    expect(sleepCalls).toEqual([100, 200]);
  });

  it('4xx is NOT retried', async () => {
    const { f, calls } = makeFetchSpy([{ status: 404 }, { status: 200 }]);
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      fetch: f,
      sleep,
      random: () => 0,
    });
    const r = await a.send('webhook://alerts', { text: 'x' });
    expect(r).toEqual({ ok: false, error: 'webhook 404' });
    expect(calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it('retries on thrown network error then succeeds', async () => {
    const calls: number[] = [];
    let i = 0;
    const f: typeof fetch = () => {
      calls.push(i);
      i += 1;
      if (calls.length === 1) throw new Error('econnreset');
      return Promise.resolve({ ok: true, status: 200 } as unknown as Response);
    };
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      fetch: f,
      sleep,
      random: () => 0,
    });
    const r = await a.send('webhook://alerts', { text: 'x' });
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('returns error on final-attempt network failure and redacts secret', async () => {
    const f: typeof fetch = () => {
      throw new Error('network down (secret leaked: top-secret-key)');
    };
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      signingSecret: 'top-secret-key',
      fetch: f,
      sleep,
      random: () => 0,
    });
    const r = await a.send('webhook://alerts', { text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('top-secret-key');
    expect(r.error).toContain('[redacted]');
  });
});

describe('webhookAdapter — HMAC signing', () => {
  it('adds x-opensquid-signature header matching HMAC-SHA256 of body', async () => {
    const { f, calls } = makeFetchSpy([{ status: 200 }]);
    const secret = 'my-shared-secret';
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      signingSecret: secret,
      fetch: f,
      sleep,
    });
    const r = await a.send('webhook://alerts', { text: 'hello', severity: 'critical' });
    expect(r.ok).toBe(true);
    const sentBody = calls[0]?.init?.body ?? '';
    const sig = calls[0]?.init?.headers?.['x-opensquid-signature'];
    const expected = `sha256=${createHmac('sha256', secret).update(sentBody).digest('hex')}`;
    expect(sig).toBe(expected);
  });

  it('omits signature header when signingSecret is absent', async () => {
    const { f, calls } = makeFetchSpy([{ status: 200 }]);
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      fetch: f,
      sleep,
    });
    await a.send('webhook://alerts', { text: 'hi' });
    expect(calls[0]?.init?.headers?.['x-opensquid-signature']).toBeUndefined();
  });

  it('treats empty signingSecret as "no signing"', async () => {
    const { f, calls } = makeFetchSpy([{ status: 200 }]);
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      signingSecret: '',
      fetch: f,
      sleep,
    });
    await a.send('webhook://alerts', { text: 'hi' });
    expect(calls[0]?.init?.headers?.['x-opensquid-signature']).toBeUndefined();
  });
});

describe('webhookAdapter — secret discipline', () => {
  it('never includes signing secret in any sent header value', async () => {
    const { f, calls } = makeFetchSpy([{ status: 200 }]);
    const secret = 'leak-canary-12345';
    const a = webhookAdapter({
      name: 'alerts',
      url: 'https://x.com',
      signingSecret: secret,
      fetch: f,
      sleep,
    });
    await a.send('webhook://alerts', { text: 'hi' });
    const headers = calls[0]?.init?.headers ?? {};
    for (const v of Object.values(headers)) {
      expect(v).not.toContain(secret);
    }
    const body = calls[0]?.init?.body ?? '';
    expect(body).not.toContain(secret);
  });
});

// vi import is kept available for future expansion; suppress unused warning.
void vi;

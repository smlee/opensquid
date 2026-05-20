/**
 * webhook:// adapter — generic outbound HTTPS POST with optional HMAC
 * signing and jittered exponential backoff on 5xx.
 *
 * URI scheme: `webhook://<name>` where `<name>` is an exact string
 * match against `opts.name`. Each webhookAdapter instance handles
 * exactly one URI — the runtime registers one adapter per configured
 * webhook endpoint.
 *
 * Body: JSON `{ text, severity }`. We keep the surface minimal so the
 * receiver doesn't need to parse opensquid-internal types.
 *
 * Signature header (optional): `x-opensquid-signature: sha256=<hex>`
 * where `<hex>` is the lowercase HMAC-SHA256 of the raw response body
 * keyed by `signingSecret`. Receivers should compute the same HMAC and
 * timing-safe compare. The convention mirrors GitHub's webhook spec.
 *
 * Retry policy: 3 total attempts. On 5xx, wait `100ms × 2^attempt + jitter`
 * (jitter ≤ half the base delay) then retry. 4xx and network errors on
 * the final attempt are not retried. The exit shape is always a
 * SendResult — the adapter never throws.
 *
 * Security: `signingSecret` is closed over by this function and never
 * appears in any log line, error string, or returned SendResult. Same
 * discipline as the Telegram/Discord/Slack adapters.
 */

import { createHmac } from 'node:crypto';
import type { ChannelAdapter, ChannelMessage, SendResult } from '../types.js';

export interface WebhookAdapterOpts {
  /** Name segment in the URI: `webhook://<name>`. Must be non-empty. */
  name: string;
  /** Destination URL (https:// recommended). */
  url: string;
  /** Optional HMAC-SHA256 signing key. When set, every POST carries
   * `x-opensquid-signature: sha256=<hex>`. */
  signingSecret?: string;
  /**
   * Injection seam for tests — defaults to the global `fetch`. Production
   * callers should leave this unset.
   */
  fetch?: typeof fetch;
  /**
   * Injection seam for tests — defaults to `Math.random()`. Production
   * callers should leave this unset.
   */
  random?: () => number;
  /**
   * Injection seam for the backoff sleep — defaults to `setTimeout`-
   * based promise. Tests pass a synchronous stub.
   */
  sleep?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 100;

/** Default jittered exponential backoff: `100ms × 2^attempt + jitter`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function webhookAdapter(opts: WebhookAdapterOpts): ChannelAdapter {
  const f = opts.fetch ?? fetch;
  const rng = opts.random ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const expectedUri = `webhook://${opts.name}`;

  function sign(body: string): string | null {
    if (opts.signingSecret === undefined || opts.signingSecret === '') return null;
    const hex = createHmac('sha256', opts.signingSecret).update(body).digest('hex');
    return `sha256=${hex}`;
  }

  /** Jittered backoff for attempt index `i` (0-based). */
  function backoffMs(i: number): number {
    const base = BASE_DELAY_MS * 2 ** i;
    // Jitter is up to half the base delay — keeps retries deterministic
    // enough to test while still spreading load.
    const jitter = Math.floor(rng() * (base / 2));
    return base + jitter;
  }

  return {
    scheme: 'webhook',

    validate(uri: string): boolean {
      return uri === expectedUri;
    },

    async send(uri: string, message: ChannelMessage): Promise<SendResult> {
      if (uri !== expectedUri) return { ok: false, error: 'bad uri' };
      const body = JSON.stringify({ text: message.text, severity: message.severity });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const signature = sign(body);
      if (signature !== null) headers['x-opensquid-signature'] = signature;

      let lastError = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const res = await f(opts.url, { method: 'POST', headers, body });
          if (res.ok) return { ok: true };
          if (res.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
            await sleep(backoffMs(attempt));
            lastError = `webhook ${res.status}`;
            continue;
          }
          // 4xx, or 5xx on final attempt — non-retryable.
          return { ok: false, error: `webhook ${res.status}` };
        } catch (e: unknown) {
          lastError = e instanceof Error ? e.message : String(e);
          if (attempt < MAX_ATTEMPTS - 1) {
            await sleep(backoffMs(attempt));
            continue;
          }
          return { ok: false, error: redactSecret(lastError, opts.signingSecret) };
        }
      }
      return { ok: false, error: redactSecret(lastError || 'unreachable', opts.signingSecret) };
    },
  };
}

function redactSecret(message: string, secret: string | undefined): string {
  if (secret === undefined || secret === '') return message;
  return message.replaceAll(secret, '[redacted]');
}

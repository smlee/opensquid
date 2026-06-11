/**
 * Webhook intake — single-route http.Server that verifies HMAC, dedups via
 * an in-memory idempotency cache, and hands a `WebhookEvent` to the daemon
 * dispatcher. Source: SCHED.1.
 *
 * Route: `POST /webhook/<subscription_id>` only — multiplexing live trigger
 * sources (schedule, file_changed, inbound_channel) belongs to the daemon,
 * not the HTTP layer.
 *
 * HMAC: header `X-OpenSquid-Signature: sha256=<lowercase-hex>`, body is the
 * raw request bytes (never re-JSON-serialized — that would re-key the
 * payload and invalidate any external signature). Compare via
 * `crypto.timingSafeEqual` on equal-length buffers; even on length mismatch
 * we still exercise the constant-time path to deny header-length probing.
 * No fallback header name — provider-specific signatures (Stripe etc.) land
 * as future adapter tasks.
 *
 * Idempotency: `Map<key, ts>` keyed `subscription_id:sha256(body)`. Duplicate
 * POSTs within `idempotencyTtlMs` (default 24h) return 200 + `idempotent:
 * true` and skip dispatch. A `setInterval` evicts stale entries hourly and
 * is `.unref()`'d so it never holds the process open. In-memory only —
 * restart loses the dedup window. DURABLE.4 may migrate to libsql later.
 *
 * Rate-limit: when `subscription.rateLimit` is set, the server consults the
 * daemon-provided `RateLimiter` under trigger kind `'webhook'`. Denied
 * webhooks return 429 + `Retry-After` (seconds). Never silently drop;
 * never silently allow.
 *
 * Logging discipline: the server NEVER logs `signingSecret` (audits carry
 * subscription id only) and NEVER logs request bodies (PII / bearer
 * tokens / carrier creds).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { WebhookEvent } from './event.js';
import type { RateLimiter } from './rate_limit.js';
import type { Subscription } from './webhook_subscriptions.js';

/** Audit sink — caller plugs in a libsql writer / stderr / NotificationRouter. */
export type WebhookAuditEntry =
  | { event: 'received'; subscriptionId: string; receivedAt: string }
  | { event: 'rejected_hmac'; subscriptionId: string; receivedAt: string }
  | { event: 'rejected_unknown'; subscriptionId: string; receivedAt: string }
  | { event: 'rejected_method'; method: string; receivedAt: string }
  | { event: 'rejected_rate_limit'; subscriptionId: string; receivedAt: string }
  | { event: 'idempotent'; subscriptionId: string; receivedAt: string }
  | { event: 'dispatched'; subscriptionId: string; receivedAt: string }
  | {
      event: 'deliver_only';
      subscriptionId: string;
      receivedAt: string;
      rendered: boolean;
      reason?: 'empty_template' | 'multicast_error' | 'misconfigured';
      emptyFieldCount?: number;
      redactedSecrets?: number;
      multicastSent?: number;
      multicastFailed?: number;
    }
  | { event: 'error'; reason: string; receivedAt: string };

export type WebhookAuditSink = (entry: WebhookAuditEntry) => void;

/** What the daemon hands the server for an authenticated webhook. */
export type WebhookDispatcher = (event: WebhookEvent) => Promise<void>;

/**
 * SCHED.2 zero-LLM handler. Caller supplies a closure that wires the
 * NotificationRouter + RoutingConfig; the server invokes it for any
 * subscription with `deliverOnly: true`. Returning a result lets the
 * server audit the outcome without coupling to mustache or channels.
 */
export type DeliverOnlyHandler = (
  sub: Subscription,
  body: unknown,
) => Promise<{
  rendered: boolean;
  reason?: 'empty_template' | 'multicast_error' | 'misconfigured';
  emptyFieldCount?: number;
  redactedSecrets?: number;
  multicast?: { sent: number; failed: number };
}>;

export interface WebhookServerOpts {
  port: number;
  /** `'127.0.0.1'` (default) keeps the server unreachable from LAN. */
  host?: string;
  subscriptions: readonly Subscription[];
  dispatch: WebhookDispatcher;
  /** SCHED.2 — invoked for subscriptions with `deliverOnly: true`. When
   *  unset, deliver-only subscriptions audit as `misconfigured` and the
   *  request still returns 200 (never break on missing handler). */
  deliverOnly?: DeliverOnlyHandler;
  rateLimiter?: RateLimiter;
  auditLog?: WebhookAuditSink;
  /** Injected clock for tests. */
  now?: () => number;
  /** Idempotency window. Default 24h. */
  idempotencyTtlMs?: number;
}

/** 24h in ms — locked per spec. */
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_EVICT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB — bound memory; configurable later.

const noopAudit: WebhookAuditSink = () => {
  /* default audit sink (named to satisfy eslint no-empty-function) */
};

/**
 * `http.Server` wrapper. Caller `start()`s once; `close()` waits for the
 * connection drain + clears the eviction timer. Restart = new instance.
 */
export class WebhookServer {
  private readonly server: Server;
  private readonly subscriptions: Map<string, Subscription>;
  private readonly dispatch: WebhookDispatcher;
  private readonly deliverOnly: DeliverOnlyHandler | undefined;
  private readonly rateLimiter: RateLimiter | undefined;
  private readonly auditLog: WebhookAuditSink;
  private readonly nowFn: () => number;
  private readonly idempotencyTtlMs: number;
  private readonly idempotencyCache = new Map<string, number>();
  private evictTimer: NodeJS.Timeout | null = null;
  private listening = false;

  constructor(private readonly opts: WebhookServerOpts) {
    this.subscriptions = new Map(opts.subscriptions.map((s) => [s.id, s]));
    this.dispatch = opts.dispatch;
    this.deliverOnly = opts.deliverOnly;
    this.rateLimiter = opts.rateLimiter;
    this.auditLog = opts.auditLog ?? noopAudit;
    this.nowFn = opts.now ?? Date.now;
    this.idempotencyTtlMs = opts.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;

    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.auditLog({
          event: 'error',
          reason: err instanceof Error ? err.message : String(err),
          receivedAt: new Date(this.nowFn()).toISOString(),
        });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
    });
  }

  /** Bind to the configured port + start the eviction timer. */
  start(): Promise<void> {
    if (this.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const host = this.opts.host ?? '127.0.0.1';
      const onError = (err: Error): void => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.opts.port, host, () => {
        this.server.off('error', onError);
        this.listening = true;
        this.evictTimer = setInterval(
          () => this.evictIdempotencyCache(),
          IDEMPOTENCY_EVICT_INTERVAL_MS,
        );
        this.evictTimer.unref();
        resolve();
      });
    });
  }

  /** Stop accepting new connections, drain in-flight, clear the timer. */
  async close(): Promise<void> {
    if (!this.listening) return;
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    this.listening = false;
  }

  /** `Server.address()` resolves to a port number after `listen()` returns. */
  address(): { port: number; host: string } | null {
    const addr = this.server.address();
    if (addr === null || typeof addr === 'string') return null;
    return { port: addr.port, host: addr.address };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const receivedAt = new Date(this.nowFn()).toISOString();

    if (req.method !== 'POST') {
      this.auditLog({ event: 'rejected_method', method: req.method ?? '<unknown>', receivedAt });
      return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    }

    const match = /^\/webhook\/([A-Za-z0-9._-]+)\/?$/.exec((req.url ?? '').split('?')[0] ?? '');
    if (!match) return sendJson(res, 404, { error: 'not_found' });

    const subscriptionId = match[1] ?? '';
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) {
      this.auditLog({ event: 'rejected_unknown', subscriptionId, receivedAt });
      return sendJson(res, 404, { error: 'unknown_subscription' });
    }

    const body = await readBody(req);
    if (body === null) return sendJson(res, 413, { error: 'body_too_large' });

    const sigHeader = req.headers['x-opensquid-signature'] ?? req.headers['X-OpenSquid-Signature'];
    const provided = typeof sigHeader === 'string' ? sigHeader : '';
    if (!verifyHmac(sub.signingSecret, body, provided)) {
      this.auditLog({ event: 'rejected_hmac', subscriptionId, receivedAt });
      return sendJson(res, 401, { error: 'invalid_signature' });
    }

    let acquiredSlot = false;
    if (sub.rateLimit && this.rateLimiter) {
      const decision = await this.rateLimiter.check(sub.pack, 'webhook', sub.id);
      if (!decision.allowed) {
        const retrySec = String(Math.max(1, Math.ceil((decision.retryAfterMs ?? 1000) / 1000)));
        this.auditLog({ event: 'rejected_rate_limit', subscriptionId, receivedAt });
        return sendJson(
          res,
          429,
          { error: 'rate_limit_exceeded', reason: decision.reason },
          { 'retry-after': retrySec },
        );
      }
      acquiredSlot = true;
    }

    // FAC.1 (wg-8f7d9b919a40): the concurrent slot acquired by check()
    // guards the triggered RUN — EVERY post-check exit (idempotent return,
    // deliver-only returns, dispatch completion, throws) must release it.
    // release() floors at 0 and no-ops when unconfigured (rate_limit.ts
    // contract), and the acquired flag keeps denied/unconfigured paths out.
    try {
      return await this.handleAfterRateLimit(req, res, sub, subscriptionId, body, receivedAt);
    } finally {
      if (acquiredSlot && this.rateLimiter) {
        await this.rateLimiter.release(sub.pack, 'webhook', sub.id);
      }
    }
  }

  private async handleAfterRateLimit(
    req: IncomingMessage,
    res: ServerResponse,
    sub: Subscription,
    subscriptionId: string,
    body: Buffer,
    receivedAt: string,
  ): Promise<void> {
    const dedupKey = `${sub.id}:${createHash('sha256').update(body).digest('hex')}`;
    const now = this.nowFn();
    const seenAt = this.idempotencyCache.get(dedupKey);
    if (seenAt !== undefined && now - seenAt < this.idempotencyTtlMs) {
      this.auditLog({ event: 'idempotent', subscriptionId, receivedAt });
      return sendJson(res, 200, { idempotent: true, subscriptionId: sub.id });
    }
    this.idempotencyCache.set(dedupKey, now);

    this.auditLog({ event: 'received', subscriptionId, receivedAt });

    // SCHED.2: deliver-only subscriptions skip the runtime evaluator
    // entirely. Mustache-render the body straight into the
    // NotificationRouter — zero LLM invocation, sub-second response.
    if (sub.deliverOnly) {
      const event = buildWebhookEvent(sub.id, req, body, receivedAt);
      if (this.deliverOnly) {
        const result = await this.deliverOnly(sub, event.body);
        this.auditLog({
          event: 'deliver_only',
          subscriptionId,
          receivedAt,
          rendered: result.rendered,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.emptyFieldCount !== undefined
            ? { emptyFieldCount: result.emptyFieldCount }
            : {}),
          ...(result.redactedSecrets !== undefined
            ? { redactedSecrets: result.redactedSecrets }
            : {}),
          ...(result.multicast
            ? {
                multicastSent: result.multicast.sent,
                multicastFailed: result.multicast.failed,
              }
            : {}),
        });
        return sendJson(res, 200, {
          accepted: true,
          subscriptionId: sub.id,
          delivered: result.rendered,
          ...(result.reason ? { reason: result.reason } : {}),
        });
      }
      // Handler unset — audit + return 200 (don't break the integration).
      this.auditLog({
        event: 'deliver_only',
        subscriptionId,
        receivedAt,
        rendered: false,
        reason: 'misconfigured',
      });
      return sendJson(res, 200, {
        accepted: true,
        subscriptionId: sub.id,
        delivered: false,
        reason: 'misconfigured',
      });
    }

    await this.dispatch(buildWebhookEvent(sub.id, req, body, receivedAt));
    this.auditLog({ event: 'dispatched', subscriptionId, receivedAt });
    return sendJson(res, 200, { accepted: true, subscriptionId: sub.id });
  }

  private evictIdempotencyCache(): void {
    const cutoff = this.nowFn() - this.idempotencyTtlMs;
    for (const [k, ts] of this.idempotencyCache) {
      if (ts < cutoff) this.idempotencyCache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Response + HMAC + body helpers — module-local so they're testable in
// isolation but not part of the WebhookServer's public surface.

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** Constant-time HMAC compare. Returns false on any malformed header. */
function verifyHmac(secret: string, body: Buffer, header: string): boolean {
  if (!header) return false;
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(header.trim());
  if (!match) return false;
  const providedHex = (match[1] ?? '').toLowerCase();
  const expectedHex = createHmac('sha256', secret).update(body).digest('hex');
  const providedBuf = Buffer.from(providedHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  // Always run timingSafeEqual against equal-length buffers to keep the
  // compare constant-time regardless of header length.
  if (providedBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf); // exercise the path
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Read up to `MAX_BODY_BYTES`. Returns `null` if cap exceeded. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

/** Build the `WebhookEvent` payload the runtime evaluator consumes. */
function buildWebhookEvent(
  subscriptionId: string,
  req: IncomingMessage,
  body: Buffer,
  receivedAt: string,
): WebhookEvent {
  // Headers in node:http arrive as `string | string[] | undefined`. The
  // Event schema requires `Record<string, string>`; flatten arrays to a
  // comma-joined string so downstream rules see a stable shape.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers[k] = Array.isArray(v) ? v.join(',') : v;
  }

  // Body parse: best-effort JSON, fall back to raw text. Anything binary
  // becomes a base64 string under `__binary` — pack rules that care can
  // decode it explicitly via `from_base64`.
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString('utf8'));
  } catch {
    const text = body.toString('utf8');
    // Detect non-UTF8 body: a round-trip through UTF-8 lossily replaces
    // non-decodable bytes with U+FFFD. If the byte counts differ, treat
    // as binary.
    parsedBody =
      Buffer.byteLength(text, 'utf8') === body.length
        ? text
        : { __binary: body.toString('base64') };
  }

  return {
    kind: 'webhook',
    subscriptionId,
    method: (req.method ?? 'POST') as 'POST',
    headers,
    body: parsedBody,
    receivedAt,
  };
}

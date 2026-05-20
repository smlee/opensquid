/**
 * Tests for SCHED.2 deliver-only path — Mustache render → multicast.
 *
 * Coverage (≥ 5 required by spec):
 *   1. Happy path — GitHub push payload renders + multicasts via router.
 *   2. Missing field — empty interpolation, no error.
 *   3. Empty array reference (`{{commits.0.message}}`) — empty interpolation.
 *   4. Whole-template empty → no multicast, reason `empty_template`.
 *   5. Multicast partial failure → reason `multicast_error`, errors propagated.
 *   6. Secret-pattern stripping — `api_key`, `token`, `secret` redacted.
 *   7. Zero-LLM grep — verify no LLM-call symbols live in deliver_only.ts.
 *   8. Misconfigured subscription (missing template/deliver_to/severity) →
 *      no throw; reason `misconfigured`.
 *   9. Sub-second latency — full render + multicast completes < 500ms.
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { NotificationRouter } from '../channels/router.js';
import type { ChannelAdapter, RoutingConfig, SendResult } from '../channels/types.js';

import { handleDeliverOnly, stripSecrets } from './deliver_only.js';
import type { Subscription } from './webhook_subscriptions.js';

// ---------------------------------------------------------------------------
// Fixtures.

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'github-push',
    pack: 'ci-monitor',
    signingSecret: 'sk_test_unused',
    deliverOnly: true,
    template:
      'Push to {{repository.full_name}} by {{pusher.name}}\nCommits: {{commits.length}}\nFirst: {{commits.0.message}}\nBranch: {{ref}}',
    deliverTo: 'alerts',
    severity: 'info',
    ...overrides,
  };
}

const ROUTING: RoutingConfig = {
  severityTiers: {
    critical: ['alerts'],
    error: ['alerts'],
    warning: ['alerts'],
    info: ['alerts'],
  },
  channelMapping: { alerts: 'capture://test' },
};

class CaptureAdapter implements ChannelAdapter {
  scheme = 'capture';
  sent: { uri: string; text: string }[] = [];
  result: SendResult = { ok: true };
  validate(uri: string): boolean {
    return uri.startsWith('capture://');
  }
  send(uri: string, message: { text: string }): Promise<SendResult> {
    this.sent.push({ uri, text: message.text });
    return Promise.resolve(this.result);
  }
}

function makeRouter(adapter: ChannelAdapter): NotificationRouter {
  const router = new NotificationRouter();
  router.registerAdapter(adapter);
  return router;
}

const GITHUB_PUSH_BODY = {
  ref: 'refs/heads/main',
  repository: { full_name: 'smlee/opensquid' },
  pusher: { name: 'sangmlee23' },
  commits: [
    { message: 'release: 0.5.66 — deliver-only webhook mode (SCHED.2)' },
    { message: 'follow-up: tighten audit log' },
  ],
};

// ---------------------------------------------------------------------------

describe('handleDeliverOnly — happy path', () => {
  it('renders the template against a GitHub push payload + multicasts', async () => {
    const adapter = new CaptureAdapter();
    const router = makeRouter(adapter);
    const result = await handleDeliverOnly(makeSub(), GITHUB_PUSH_BODY, router, ROUTING);

    expect(result.rendered).toBe(true);
    expect(result.text).toContain('Push to smlee/opensquid by sangmlee23');
    expect(result.text).toContain('Commits: 2');
    expect(result.text).toContain('First: release: 0.5.66');
    expect(result.text).toContain('Branch: refs/heads/main');
    expect(adapter.sent).toHaveLength(1);
    expect(result.multicast?.sent).toBe(1);
    expect(result.multicast?.failed).toBe(0);
  });
});

describe('handleDeliverOnly — missing-field semantics', () => {
  it('renders empty interpolation for a missing top-level field, no error', async () => {
    const adapter = new CaptureAdapter();
    const router = makeRouter(adapter);
    const body = { ref: 'refs/heads/main', repository: { full_name: 'smlee/opensquid' } };
    const result = await handleDeliverOnly(makeSub(), body, router, ROUTING);

    expect(result.rendered).toBe(true);
    // `pusher.name` resolves to empty; line still renders with the literal text.
    expect(result.text).toContain('Push to smlee/opensquid by ');
    expect(result.emptyFieldCount).toBeGreaterThanOrEqual(2);
  });

  it('renders empty interpolation for an out-of-bounds array index', async () => {
    const adapter = new CaptureAdapter();
    const router = makeRouter(adapter);
    const body = {
      ref: 'refs/heads/main',
      repository: { full_name: 'r' },
      pusher: { name: 'p' },
      commits: [],
    };
    const result = await handleDeliverOnly(makeSub(), body, router, ROUTING);

    expect(result.rendered).toBe(true);
    expect(result.text).toContain('Commits: 0');
    expect(result.text).toContain('First: ');
    expect(result.emptyFieldCount).toBeGreaterThanOrEqual(1);
  });
});

describe('handleDeliverOnly — empty template', () => {
  it('skips multicast when the rendered text trims to empty', async () => {
    const adapter = new CaptureAdapter();
    const router = makeRouter(adapter);
    // Template references only absent fields → renders to whitespace only.
    const sub = makeSub({ template: '{{a}}{{b}}{{c}}' });
    const result = await handleDeliverOnly(sub, {}, router, ROUTING);

    expect(result.rendered).toBe(false);
    expect(result.reason).toBe('empty_template');
    expect(adapter.sent).toHaveLength(0);
    expect(result.multicast).toBeUndefined();
  });
});

describe('handleDeliverOnly — multicast failure', () => {
  it('propagates multicast errors in the result, never swallows', async () => {
    const adapter = new CaptureAdapter();
    adapter.result = { ok: false, error: 'channel offline' };
    const router = makeRouter(adapter);
    const result = await handleDeliverOnly(makeSub(), GITHUB_PUSH_BODY, router, ROUTING);

    expect(result.rendered).toBe(true);
    expect(result.reason).toBe('multicast_error');
    expect(result.multicast?.failed).toBe(1);
    expect(result.multicast?.errors).toContain('channel offline');
  });
});

describe('handleDeliverOnly — secret stripping', () => {
  it('redacts api_key / secret / token / password / authorization patterns', async () => {
    const adapter = new CaptureAdapter();
    const router = makeRouter(adapter);
    const sub = makeSub({ template: '{{payload}}' });
    const body = {
      payload:
        'api_key: sk_live_abcdefghijkl token=Bearer_xyz98765 secret="topsecretvalue" password: hunter2hunter2 authorization=Basic_abc12345',
    };
    const result = await handleDeliverOnly(sub, body, router, ROUTING);

    expect(result.rendered).toBe(true);
    expect(result.text).not.toContain('sk_live_abcdefghijkl');
    expect(result.text).not.toContain('Bearer_xyz98765');
    expect(result.text).not.toContain('topsecretvalue');
    expect(result.text).not.toContain('hunter2hunter2');
    expect(result.text).not.toContain('Basic_abc12345');
    expect(result.text).toContain('<redacted>');
    expect(result.redactedSecrets).toBeGreaterThanOrEqual(5);
  });

  it('exposes a standalone stripSecrets() helper for module reuse', () => {
    const { text, redactedSecrets } = stripSecrets('token: abcdef123456');
    expect(text).toContain('<redacted>');
    expect(text).not.toContain('abcdef123456');
    expect(redactedSecrets).toBe(1);
  });
});

describe('handleDeliverOnly — misconfigured', () => {
  it('returns reason=misconfigured when required fields are missing', async () => {
    const adapter = new CaptureAdapter();
    const router = makeRouter(adapter);
    // Synthesize a deliver-only sub without the required fields (load
    // schema would normally reject this — we exercise the defensive
    // runtime guard).
    const sub: Subscription = {
      id: 'broken',
      pack: 'p',
      signingSecret: 's',
      deliverOnly: true,
    };
    const result = await handleDeliverOnly(sub, {}, router, ROUTING);
    expect(result.rendered).toBe(false);
    expect(result.reason).toBe('misconfigured');
    expect(adapter.sent).toHaveLength(0);
  });
});

describe('handleDeliverOnly — zero LLM invocation (grep guard)', () => {
  it('deliver_only.ts contains no LLM-call symbols', async () => {
    const source = await readFile(new URL('./deliver_only.ts', import.meta.url), 'utf8');
    // None of these substrings may appear in the deliver-only module.
    // If any does, an LLM-call path leaked in and SCHED.2's zero-LLM
    // contract is broken.
    const forbidden = [
      'dispatcher.call',
      'llm_classify',
      'subagent_call',
      'ModelDispatcher',
      'anthropic',
      'openai',
    ];
    for (const needle of forbidden) {
      expect(source.toLowerCase()).not.toContain(needle.toLowerCase());
    }
  });
});

describe('handleDeliverOnly — latency', () => {
  it('completes render + multicast in well under 500ms on a representative payload', async () => {
    const adapter = new CaptureAdapter();
    const router = makeRouter(adapter);
    const t0 = Date.now();
    await handleDeliverOnly(makeSub(), GITHUB_PUSH_BODY, router, ROUTING);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});

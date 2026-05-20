/**
 * Tests for CLI.3 — `opensquid webhooks list|subscribe|unsubscribe|test|
 * rotate`.
 *
 * Strategy mirrors triggers.test.ts + schedule.test.ts: a fresh tmpdir per
 * test for `~/.opensquid/webhooks.yaml`, commander parsed with injected
 * stdout/stderr/isTty/now/fetch deps. Secret leakage is covered by
 * asserting on the stdout/stderr buffers directly: the only verb that may
 * emit a raw hex secret is `subscribe` / `rotate` (by design — that's the
 * one moment the user needs it). All other verbs MUST surface `[REDACTED]`.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultWebhookPort,
  literalSecretUri,
  readWebhooksFile,
  unwrapLiteralSecret,
} from './webhooks_state.js';
import { registerWebhooks, type WebhookFetch } from './webhooks.js';

let stateRoot: string;
let webhooksPath: string;
let outChunks: string[];
let errChunks: string[];
let priorHome: string | undefined;

const out = (s: string): void => {
  outChunks.push(s);
};
const errSink = (s: string): void => {
  errChunks.push(s);
};
const outText = (): string => outChunks.join('');
const errText = (): string => errChunks.join('');

const fixedNow = (): Date => new Date('2026-05-20T08:00:00Z');

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  stateRoot = await mkdtemp(join(tmpdir(), 'opensquid-webhooks-state-'));
  process.env.OPENSQUID_HOME = stateRoot;
  webhooksPath = join(stateRoot, 'webhooks.yaml');
  outChunks = [];
  errChunks = [];
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  vi.restoreAllMocks();
});

function build(deps: Parameters<typeof registerWebhooks>[1] = {}): Command {
  const program = new Command();
  registerWebhooks(program, {
    webhooksPath,
    port: defaultWebhookPort(),
    stdout: out,
    stderr: errSink,
    isTty: () => false,
    now: fixedNow,
    ...deps,
  });
  return program;
}

const argv = (...args: string[]): string[] => ['node', 'cli', 'webhooks', ...args];

describe('opensquid webhooks list', () => {
  it('reports "(no webhook subscriptions)" on empty store', async () => {
    await build().parseAsync(argv('list'));
    expect(outText()).toContain('(no webhook subscriptions)');
  });

  it('renders the table with SECRET as [REDACTED] (NEVER raw hex)', async () => {
    // Seed a fixture subscription with a known secret.
    const secretHex = '0123456789abcdef'.repeat(4); // 64-char hex
    await writeFile(
      webhooksPath,
      [
        'subscriptions:',
        '  - id: stripe',
        '    pack: billing',
        '    skill: stripe-router',
        `    secret: ${literalSecretUri(secretHex)}`,
        '',
      ].join('\n'),
      'utf8',
    );
    await build().parseAsync(argv('list'));
    const t = outText();
    expect(t).toContain('ID');
    expect(t).toContain('SECRET');
    expect(t).toContain('[REDACTED]');
    expect(t).toContain('stripe');
    expect(t).toContain('billing');
    expect(t).toContain('http://localhost:8765/webhook/stripe');
    // Secret must NOT appear at INFO log level.
    expect(t).not.toContain(secretHex);
    expect(errText()).not.toContain(secretHex);
  });
});

describe('opensquid webhooks subscribe — mode mutex', () => {
  it('exits 1 when NEITHER --skill nor --deliver-only provided', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'billing'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('must pick exactly one mode');
    expect(errText()).toContain('--skill');
    expect(errText()).toContain('--deliver-only');
    // Nothing written to disk on failure.
    expect(await readWebhooksFile(webhooksPath)).toHaveLength(0);
    process.exitCode = prev;
  });

  it('exits 1 when BOTH --skill and --deliver-only provided', async () => {
    const prev = process.exitCode;
    await build().parseAsync(
      argv(
        'subscribe',
        'gh',
        '--pack',
        'ci',
        '--skill',
        'gh-router',
        '--deliver-only',
        '--deliver',
        'alerts',
        '--template',
        '{{x}}',
        '--severity',
        'info',
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('mutually exclusive');
    expect(await readWebhooksFile(webhooksPath)).toHaveLength(0);
    process.exitCode = prev;
  });
});

describe('opensquid webhooks subscribe — happy paths', () => {
  it('skill-mode subscribe writes a record + prints URL + hex secret', async () => {
    await build().parseAsync(
      argv('subscribe', 'stripe', '--pack', 'billing', '--skill', 'stripe-router'),
    );
    const parsed = JSON.parse(outText()) as Record<string, unknown>;
    expect(parsed.id).toBe('stripe');
    expect(parsed.pack).toBe('billing');
    expect(parsed.mode).toBe('skill');
    expect(parsed.url).toBe('http://localhost:8765/webhook/stripe');
    expect(typeof parsed.secret).toBe('string');
    expect(parsed.secret as string).toMatch(/^[0-9a-f]{64}$/);

    const persisted = await readWebhooksFile(webhooksPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.skill).toBe('stripe-router');
    expect(persisted[0]?.deliver_only).toBeUndefined();
    expect(persisted[0]?.secret.startsWith('literal:')).toBe(true);
    // Secret hex stored on disk matches what was returned.
    const unwrapped = unwrapLiteralSecret(persisted[0]!.secret);
    expect(unwrapped.value).toBe(parsed.secret);
    expect(persisted[0]?.created_at).toBe('2026-05-20T08:00:00.000Z');
  });

  it('deliver-only subscribe persists template + deliver_to + severity', async () => {
    await build().parseAsync(
      argv(
        'subscribe',
        'gh-push',
        '--pack',
        'ci',
        '--deliver-only',
        '--deliver',
        'alerts',
        '--template',
        'pushed {{ref}}',
        '--severity',
        'warning',
      ),
    );
    const persisted = await readWebhooksFile(webhooksPath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.deliver_only).toBe(true);
    expect(persisted[0]?.template).toBe('pushed {{ref}}');
    expect(persisted[0]?.deliver_to).toBe('alerts');
    expect(persisted[0]?.severity).toBe('warning');
    expect(persisted[0]?.skill).toBeUndefined();
  });

  it('deliver-only without --template exits 1 with explicit field name', async () => {
    const prev = process.exitCode;
    await build().parseAsync(
      argv(
        'subscribe',
        'x',
        '--pack',
        'p',
        '--deliver-only',
        '--deliver',
        'alerts',
        '--severity',
        'info',
      ),
    );
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('--template is required');
    process.exitCode = prev;
  });

  it('refuses duplicate id', async () => {
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    outChunks = [];
    const prev = process.exitCode;
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('already exists');
    process.exitCode = prev;
  });
});

describe('opensquid webhooks unsubscribe', () => {
  it('removes the subscription with --yes', async () => {
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    outChunks = [];
    await build().parseAsync(argv('unsubscribe', 'stripe', '--yes'));
    expect(outText()).toContain('unsubscribed stripe');
    expect(await readWebhooksFile(webhooksPath)).toHaveLength(0);
  });

  it('refuses without --yes in non-TTY context', async () => {
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    outChunks = [];
    errChunks = [];
    const prev = process.exitCode;
    await build().parseAsync(argv('unsubscribe', 'stripe'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('refusing to remove');
    expect(await readWebhooksFile(webhooksPath)).toHaveLength(1);
    process.exitCode = prev;
  });

  it('exits 1 on unknown id', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('unsubscribe', 'nope', '--yes'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no subscription with id "nope"');
    process.exitCode = prev;
  });
});

describe('opensquid webhooks test', () => {
  it('POSTs --payload signed with the subscription secret', async () => {
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    const subscribeOut = JSON.parse(outText()) as { secret: string };
    const secretHex = subscribeOut.secret;
    outChunks = [];
    errChunks = [];

    const calls: { url: string; init: Parameters<WebhookFetch>[1] }[] = [];
    const fetchStub: WebhookFetch = async (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ status: 200, text: () => Promise.resolve('{"ok":true}') });
    };
    await build({ fetch: fetchStub }).parseAsync(
      argv('test', 'stripe', '--payload', '{"id":"evt_1"}'),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:8765/webhook/stripe');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"id":"evt_1"}');
    expect(calls[0]?.init.headers['x-opensquid-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

    // The signature must match HMAC-SHA256(secret, body).
    const { createHmac } = await import('node:crypto');
    const expected = `sha256=${createHmac('sha256', secretHex)
      .update('{"id":"evt_1"}', 'utf8')
      .digest('hex')}`;
    expect(calls[0]?.init.headers['x-opensquid-signature']).toBe(expected);

    const parsed = JSON.parse(outText()) as { status: number };
    expect(parsed.status).toBe(200);
  });

  it('exits 1 on unknown id', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('test', 'nope'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no subscription with id "nope"');
    process.exitCode = prev;
  });
});

describe('opensquid webhooks rotate — atomicity', () => {
  it('rotates the secret atomically: webhooks.yaml has NEW secret only after rotate completes', async () => {
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    const subOut = JSON.parse(outText()) as { secret: string };
    const oldSecret = subOut.secret;
    outChunks = [];

    // Inspect disk BEFORE rotate — must hold the OLD secret.
    const before = await readWebhooksFile(webhooksPath);
    const beforeSecret = unwrapLiteralSecret(before[0]!.secret).value;
    expect(beforeSecret).toBe(oldSecret);
    expect(before[0]?.rotated_at).toBeUndefined();

    await build().parseAsync(argv('rotate', 'stripe', '--yes'));
    const rotateOut = JSON.parse(outText()) as { secret: string; rotated_at: string };
    const newSecret = rotateOut.secret;
    expect(newSecret).not.toBe(oldSecret);
    expect(newSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(rotateOut.rotated_at).toBe('2026-05-20T08:00:00.000Z');

    // Inspect disk AFTER rotate — must hold the NEW secret ONLY.
    const after = await readWebhooksFile(webhooksPath);
    expect(after).toHaveLength(1);
    const afterSecret = unwrapLiteralSecret(after[0]!.secret).value;
    expect(afterSecret).toBe(newSecret);
    expect(afterSecret).not.toBe(oldSecret);
    expect(after[0]?.rotated_at).toBe('2026-05-20T08:00:00.000Z');

    // The raw yaml file must contain the NEW secret string and NOT the old one.
    const raw = await readFile(webhooksPath, 'utf8');
    expect(raw).toContain(newSecret);
    expect(raw).not.toContain(oldSecret);
  });

  it('refuses without --yes in non-TTY context', async () => {
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    const before = await readFile(webhooksPath, 'utf8');
    outChunks = [];
    errChunks = [];

    const prev = process.exitCode;
    await build().parseAsync(argv('rotate', 'stripe'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('refusing to rotate');
    // File must be untouched.
    expect(await readFile(webhooksPath, 'utf8')).toBe(before);
    process.exitCode = prev;
  });

  it('exits 1 on unknown id', async () => {
    const prev = process.exitCode;
    await build().parseAsync(argv('rotate', 'nope', '--yes'));
    expect(process.exitCode).toBe(1);
    expect(errText()).toContain('no subscription with id "nope"');
    process.exitCode = prev;
  });
});

describe('opensquid webhooks — secret leakage discipline', () => {
  it('list / unsubscribe / test stdout never includes the literal hex secret', async () => {
    await build().parseAsync(argv('subscribe', 'stripe', '--pack', 'b', '--skill', 's'));
    const subOut = JSON.parse(outText()) as { secret: string };
    const secretHex = subOut.secret;
    expect(secretHex).toMatch(/^[0-9a-f]{64}$/);

    // list
    outChunks = [];
    errChunks = [];
    await build().parseAsync(argv('list'));
    expect(outText()).not.toContain(secretHex);
    expect(errText()).not.toContain(secretHex);

    // test (uses the secret to SIGN, but does not print it)
    outChunks = [];
    errChunks = [];
    const fetchStub: WebhookFetch = async () =>
      Promise.resolve({ status: 200, text: () => Promise.resolve('') });
    await build({ fetch: fetchStub }).parseAsync(argv('test', 'stripe'));
    expect(outText()).not.toContain(secretHex);
    expect(errText()).not.toContain(secretHex);

    // unsubscribe
    outChunks = [];
    errChunks = [];
    await build().parseAsync(argv('unsubscribe', 'stripe', '--yes'));
    expect(outText()).not.toContain(secretHex);
    expect(errText()).not.toContain(secretHex);
  });
});

/**
 * Action implementations for CLI.3 — `opensquid webhooks …`.
 *
 * Split out of `webhooks.ts` (file-size budget). Each exported function is a
 * single verb's body; `webhooks.ts` wires commander to these via thin
 * `.action(opts => action(...))` bridges. Functions take all I/O via
 * explicit deps (`paths`, `out`, `err`, `isTty`, `now`, optional `fetch`)
 * so they're testable independently.
 *
 * Verb semantics (locked):
 *
 *   list        — `subscriptions:` from `~/.opensquid/webhooks.yaml`; the
 *                 secret column is ALWAYS rendered as `[REDACTED]`. Never
 *                 prints raw secrets at any log level. Subscribe is the
 *                 ONLY verb that emits the freshly-generated secret on
 *                 stdout (by design — the user needs it to configure the
 *                 upstream sender).
 *   subscribe   — generate HMAC, compose record, atomic write, print URL +
 *                 secret. Requires `--skill <name>` XOR `--deliver-only`;
 *                 errors with explicit message on neither / both.
 *   unsubscribe — confirm (`--yes` to bypass), filter list, atomic write.
 *                 Non-TTY context without `--yes` exits 1.
 *   test        — simulate POST against the running daemon at the canonical
 *                 URL. Signs body with the subscription's secret + emits the
 *                 HTTP status. `--payload <json>` overrides the default `{}`.
 *   rotate      — atomicity-critical. Generates new secret, writes the new
 *                 record set to `webhooks.yaml` FIRST (rename = atomic on
 *                 POSIX). Only AFTER the rename succeeds do we print the
 *                 new secret to stdout. If the process dies between
 *                 generate-secret and rename, NO state changed. If it dies
 *                 between rename and stdout-print, the new secret is on
 *                 disk and the user can `list` to see the rotation
 *                 happened (re-print is not possible by design — the user
 *                 must rotate again to see a fresh secret).
 *
 * Imports from: node:crypto, node:http, node:readline/promises,
 *   ./webhooks_state.
 * Imported by: src/setup/cli/webhooks.ts.
 */

import { createHmac } from 'node:crypto';

import {
  genSecret,
  literalSecretUri,
  readWebhooksFile,
  unwrapLiteralSecret,
  webhookUrl,
  writeWebhooksFile,
  type SubscriptionRecord,
} from './webhooks_state.js';

/** Severity literals from SCHED.1's `SeveritySpec`. */
const SEVERITIES = ['critical', 'error', 'warning', 'info'] as const;
type Severity = (typeof SEVERITIES)[number];

export interface WebhooksPaths {
  webhooksPath: string;
  port: number;
}

/** Test-injectable `fetch` analogue. `undefined` falls back to global fetch. */
export type WebhookFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export interface ActionDeps {
  paths: WebhooksPaths;
  out: (s: string) => void;
  err: (s: string) => void;
  isTty: () => boolean;
  now: () => Date;
  fetch?: WebhookFetch;
}

async function confirm(question: string, isTty: () => boolean): Promise<boolean> {
  if (!isTty()) return false;
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// list — kubectl-style table. Secret column is ALWAYS [REDACTED].
// ---------------------------------------------------------------------------

const LIST_COLS = ['ID', 'PACK', 'MODE', 'TARGET', 'URL', 'SECRET'] as const;

function padCell(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

export function renderListTable(rows: readonly SubscriptionRecord[], port: number): string {
  const cells = rows.map((r) => {
    const mode = r.deliver_only === true ? 'deliver-only' : 'skill';
    const target = r.deliver_only === true ? (r.deliver_to ?? '?') : (r.skill ?? '?');
    return [r.id, r.pack, mode, target, webhookUrl(r.id, port), '[REDACTED]'];
  });
  const widths = LIST_COLS.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)),
  );
  const header = LIST_COLS.map((h, i) => padCell(h, widths[i] ?? 0)).join('  ');
  const body = cells.map((row) => row.map((cell, i) => padCell(cell, widths[i] ?? 0)).join('  '));
  return [header, ...body].join('\n');
}

export async function actList(deps: ActionDeps): Promise<void> {
  const subs = await readWebhooksFile(deps.paths.webhooksPath);
  if (subs.length === 0) {
    deps.out('(no webhook subscriptions)\n');
    return;
  }
  deps.out(renderListTable(subs, deps.paths.port) + '\n');
}

// ---------------------------------------------------------------------------
// subscribe — mode-mutex + atomic append.
// ---------------------------------------------------------------------------

export interface SubscribeOpts {
  pack: string;
  skill?: string;
  deliverOnly?: boolean;
  deliver?: string;
  template?: string;
  severity?: string;
  rateLimit?: string;
}

/** Mode-mutex evidence: returns the error message if invalid; null otherwise. */
export function checkModeMutex(opts: SubscribeOpts): string | null {
  const hasSkill = opts.skill !== undefined && opts.skill.length > 0;
  const hasDeliverOnly = opts.deliverOnly === true;
  if (!hasSkill && !hasDeliverOnly) {
    return 'must pick exactly one mode: pass either --skill <name> (LLM-route mode) or --deliver-only (zero-LLM template mode)';
  }
  if (hasSkill && hasDeliverOnly) {
    return '--skill and --deliver-only are mutually exclusive: skill-mode routes through the evaluator; deliver-only renders a template without invoking the LLM';
  }
  return null;
}

function parseRateLimit(spec: string): { max: number; per: 'minute' | 'hour' | 'day' } {
  const m = /^(\d+)\/(minute|hour|day)$/.exec(spec.trim());
  if (!m)
    throw new Error(`--rate-limit "${spec}" must be "<n>/<minute|hour|day>" (e.g. "60/minute")`);
  return { max: Number.parseInt(m[1] ?? '0', 10), per: m[2] as 'minute' | 'hour' | 'day' };
}

export async function actSubscribe(
  deps: ActionDeps,
  id: string,
  opts: SubscribeOpts,
): Promise<void> {
  const existing = await readWebhooksFile(deps.paths.webhooksPath);
  if (existing.some((s) => s.id === id)) {
    deps.err(
      `opensquid webhooks subscribe: subscription "${id}" already exists (use \`opensquid webhooks rotate ${id}\` to rotate the secret, or \`opensquid webhooks unsubscribe ${id}\` first)\n`,
    );
    process.exitCode = 1;
    return;
  }
  const mutexErr = checkModeMutex(opts);
  if (mutexErr !== null) {
    deps.err(`opensquid webhooks subscribe: ${mutexErr}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.deliverOnly === true) {
    for (const field of ['deliver', 'template', 'severity'] as const) {
      if (opts[field] === undefined) {
        deps.err(
          `opensquid webhooks subscribe: --${field} is required when --deliver-only is set (SCHED.2 deliver-only mode needs template + deliver + severity together)\n`,
        );
        process.exitCode = 1;
        return;
      }
    }
    if (!SEVERITIES.includes(opts.severity as Severity)) {
      deps.err(
        `opensquid webhooks subscribe: --severity "${opts.severity ?? ''}" must be one of ${SEVERITIES.join('|')}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const hex = genSecret();
  const record: SubscriptionRecord = {
    id,
    pack: opts.pack,
    secret: literalSecretUri(hex),
    created_at: deps.now().toISOString(),
  };
  if (opts.skill !== undefined) record.skill = opts.skill;
  if (opts.deliverOnly === true) {
    // Required-field checks above guarantee these are defined.
    record.deliver_only = true;
    if (opts.template !== undefined) record.template = opts.template;
    if (opts.deliver !== undefined) record.deliver_to = opts.deliver;
    record.severity = opts.severity as Severity;
  }
  if (opts.rateLimit !== undefined) {
    try {
      record.rate_limit = parseRateLimit(opts.rateLimit);
    } catch (e) {
      deps.err(`opensquid webhooks subscribe: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  await writeWebhooksFile(deps.paths.webhooksPath, [...existing, record]);
  deps.out(
    `${JSON.stringify(
      {
        id,
        pack: opts.pack,
        mode: opts.deliverOnly === true ? 'deliver-only' : 'skill',
        url: webhookUrl(id, deps.paths.port),
        secret: hex,
        ...(record.skill !== undefined ? { skill: record.skill } : {}),
        ...(record.deliver_to !== undefined ? { deliver_to: record.deliver_to } : {}),
        ...(record.severity !== undefined ? { severity: record.severity } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

// ---------------------------------------------------------------------------
// unsubscribe — confirm + atomic rewrite.
// ---------------------------------------------------------------------------

export async function actUnsubscribe(
  deps: ActionDeps,
  id: string,
  opts: { yes: boolean },
): Promise<void> {
  const existing = await readWebhooksFile(deps.paths.webhooksPath);
  if (!existing.some((s) => s.id === id)) {
    deps.err(`opensquid webhooks unsubscribe: no subscription with id "${id}"\n`);
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !deps.isTty()) {
    deps.err(
      `opensquid webhooks unsubscribe: refusing to remove "${id}" without --yes in non-interactive context\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !(await confirm(`Unsubscribe webhook "${id}"? [y/N] `, deps.isTty))) {
    deps.out('aborted\n');
    return;
  }
  await writeWebhooksFile(
    deps.paths.webhooksPath,
    existing.filter((s) => s.id !== id),
  );
  deps.out(`unsubscribed ${id}\n`);
}

// ---------------------------------------------------------------------------
// test — simulate inbound POST + render HTTP status.
// ---------------------------------------------------------------------------

export interface TestOpts {
  payload?: string;
}

export async function actTest(deps: ActionDeps, id: string, opts: TestOpts): Promise<void> {
  const existing = await readWebhooksFile(deps.paths.webhooksPath);
  const sub = existing.find((s) => s.id === id);
  if (!sub) {
    deps.err(`opensquid webhooks test: no subscription with id "${id}"\n`);
    process.exitCode = 1;
    return;
  }
  const unwrapped = unwrapLiteralSecret(sub.secret);
  if (!unwrapped.literal) {
    deps.err(
      `opensquid webhooks test: subscription "${id}" stores a non-literal secret URI ("${sub.secret.split(':')[0] ?? '?'}:...") — \`test\` requires inline-literal secrets so the CLI can sign without configuring a resolver. Rotate the subscription to migrate.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const body = opts.payload ?? '{}';
  const sig = `sha256=${createHmac('sha256', unwrapped.value).update(body, 'utf8').digest('hex')}`;
  const url = webhookUrl(id, deps.paths.port);
  const doFetch: WebhookFetch =
    deps.fetch ??
    (async (u, init) => {
      const r = await globalThis.fetch(u, init);
      return { status: r.status, text: () => r.text() };
    });
  let status: number;
  let responseText: string;
  try {
    const r = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-opensquid-signature': sig,
      },
      body,
    });
    status = r.status;
    responseText = await r.text();
  } catch (e) {
    deps.err(
      `opensquid webhooks test: POST to ${url} failed (${
        e instanceof Error ? e.message : String(e)
      }) — is the daemon running on port ${String(deps.paths.port)}?\n`,
    );
    process.exitCode = 1;
    return;
  }
  deps.out(
    `${JSON.stringify({ id, url, status, response: safeJsonOrText(responseText) }, null, 2)}\n`,
  );
}

function safeJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// rotate — atomic secret swap.
//
// Ordering (locked):
//   1. Read full subscription set.
//   2. Generate the new secret (in-memory only — not yet on disk).
//   3. Build NEW subscription set with the rotated record (old set untouched
//      in memory). Stamp `rotated_at`.
//   4. `writeWebhooksFile` → tmp file → `rename` (POSIX-atomic). After this
//      line, webhooks.yaml is the authoritative new state.
//   5. ONLY NOW print the new secret on stdout.
//
// Failure modes:
//   - Crash before step 4: nothing changed on disk.
//   - Crash during step 4: rename is atomic, so it either succeeded or
//     didn't — the file is never half-written.
//   - Crash after step 4 / before step 5: secret is rotated on disk; the
//     user re-runs `rotate` to surface a fresh secret (re-printing the
//     existing one is not possible by design — we never read it back into
//     the user's terminal scrollback).
// ---------------------------------------------------------------------------

export async function actRotate(
  deps: ActionDeps,
  id: string,
  opts: { yes: boolean },
): Promise<void> {
  const existing = await readWebhooksFile(deps.paths.webhooksPath);
  const sub = existing.find((s) => s.id === id);
  if (!sub) {
    deps.err(`opensquid webhooks rotate: no subscription with id "${id}"\n`);
    process.exitCode = 1;
    return;
  }
  if (!opts.yes && !deps.isTty()) {
    deps.err(
      `opensquid webhooks rotate: refusing to rotate "${id}" without --yes in non-interactive context\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (
    !opts.yes &&
    !(await confirm(`Rotate HMAC secret for "${id}"? Old secret stops working. [y/N] `, deps.isTty))
  ) {
    deps.out('aborted\n');
    return;
  }

  // Step 2-3: build new state in memory (no disk writes yet).
  const hex = genSecret();
  const rotated: SubscriptionRecord = {
    ...sub,
    secret: literalSecretUri(hex),
    rotated_at: deps.now().toISOString(),
  };
  const next = existing.map((s) => (s.id === id ? rotated : s));

  // Step 4: atomic disk swap. After this returns successfully, the NEW
  // secret is the only secret on disk — old is invalidated.
  await writeWebhooksFile(deps.paths.webhooksPath, next);

  // Step 5: only now is it safe to print.
  deps.out(
    `${JSON.stringify(
      {
        id,
        url: webhookUrl(id, deps.paths.port),
        secret: hex,
        rotated_at: rotated.rotated_at,
      },
      null,
      2,
    )}\n`,
  );
}

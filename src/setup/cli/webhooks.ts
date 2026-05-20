/**
 * CLI.3 — `opensquid webhooks list|subscribe|unsubscribe|test|rotate`.
 *
 * Thin commander wiring. Verb bodies live in `./webhooks_actions.ts`;
 * persistence + secret-gen + URL helpers in `./webhooks_state.ts`. This
 * file ONLY routes commander options/args into the action functions and
 * resolves default paths from `OPENSQUID_HOME()` + the daemon webhook
 * port default.
 *
 * Verb semantics (locked):
 *
 *   list        — kubectl-style table; SECRET column is ALWAYS [REDACTED].
 *   subscribe   — `--skill <name>` XOR `--deliver-only` (mutex enforced
 *                 with an explicit error message; neither + both both exit
 *                 1). Generates 32-byte HMAC via `crypto.randomBytes`,
 *                 stores as `literal:<hex>` URI, prints URL + secret on
 *                 stdout (the ONE place a secret is intentionally surfaced).
 *   unsubscribe — confirms unless `--yes`; non-TTY without `--yes` exits 1.
 *   test        — signs `--payload` (default `{}`) with the subscription
 *                 secret + POSTs to `http://localhost:<port>/webhook/<id>`.
 *   rotate      — atomic: webhooks.yaml rewritten BEFORE the new secret is
 *                 emitted on stdout. Old secret is invalidated by the same
 *                 atomic file rename.
 *
 * Imports from: commander, ./webhooks_actions, ./webhooks_state.
 * Imported by: src/cli.ts.
 */

import {
  actList,
  actRotate,
  actSubscribe,
  actTest,
  actUnsubscribe,
  type ActionDeps,
  type SubscribeOpts,
  type TestOpts,
  type WebhookFetch,
} from './webhooks_actions.js';
import { defaultWebhookPort, defaultWebhooksPath } from './webhooks_state.js';

import type { Command } from 'commander';

export type { WebhookFetch } from './webhooks_actions.js';
export { renderListTable } from './webhooks_actions.js';

export interface WebhooksCliDeps {
  webhooksPath?: string;
  port?: number;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  isTty?: () => boolean;
  now?: () => Date;
  fetch?: WebhookFetch;
}

const defaultIsTty = (): boolean => process.stdout.isTTY === true;

function buildDeps(deps: WebhooksCliDeps): ActionDeps {
  const actionDeps: ActionDeps = {
    paths: {
      webhooksPath: deps.webhooksPath ?? defaultWebhooksPath(),
      port: deps.port ?? defaultWebhookPort(),
    },
    out: deps.stdout ?? ((s) => process.stdout.write(s)),
    err: deps.stderr ?? ((s) => process.stderr.write(s)),
    isTty: deps.isTty ?? defaultIsTty,
    now: deps.now ?? ((): Date => new Date()),
  };
  if (deps.fetch !== undefined) actionDeps.fetch = deps.fetch;
  return actionDeps;
}

export function registerWebhooks(parent: Command, deps: WebhooksCliDeps = {}): Command {
  const ad = buildDeps(deps);
  const w = parent.command('webhooks').description('Manage webhook subscriptions');

  w.command('list')
    .description('List all webhook subscriptions (secret column is always redacted)')
    .action(() => actList(ad));

  w.command('subscribe <id>')
    .description('Create a webhook subscription (--skill XOR --deliver-only required)')
    .requiredOption('--pack <pack>', 'pack id that owns this subscription')
    .option('--skill <skill>', 'route inbound to this skill (skill mode)')
    .option('--deliver-only', 'zero-LLM template render mode (SCHED.2)')
    .option('--deliver <channel>', 'abstract channel name (alerts|audit_log|...) — deliver-only')
    .option('--template <text>', 'Mustache template — deliver-only')
    .option('--severity <tier>', 'critical|error|warning|info — deliver-only')
    .option('--rate-limit <spec>', 'e.g. "60/minute"')
    .action((id: string, opts: SubscribeOpts) => actSubscribe(ad, id, opts));

  w.command('unsubscribe <id>')
    .description('Remove a webhook subscription (confirms unless --yes)')
    .option('--yes', 'skip confirmation', false)
    .action((id: string, opts: { yes: boolean }) => actUnsubscribe(ad, id, opts));

  w.command('test <id>')
    .description('Simulate inbound POST with --payload (signs with the subscription secret)')
    .option('--payload <json>', 'JSON payload string (default "{}")')
    .action((id: string, opts: TestOpts) => actTest(ad, id, opts));

  w.command('rotate <id>')
    .description('Rotate the HMAC secret (atomic; old secret invalidated by file rename)')
    .option('--yes', 'skip confirmation', false)
    .action((id: string, opts: { yes: boolean }) => actRotate(ad, id, opts));

  return w;
}

/**
 * Webhook subscription persistence helpers for CLI.3.
 *
 * Split out of `webhooks.ts` (file-size budget). Three concerns:
 *
 *   1. `readWebhooksFile` / `writeWebhooksFile` — load + atomically rewrite
 *      `~/.opensquid/webhooks.yaml`. Schema mirrors the SCHED.1 runtime
 *      loader (`src/runtime/webhook_subscriptions.ts`) so anything the CLI
 *      writes is consumable by the daemon without a second migration step.
 *      Atomic write via `tmp + rename` matches the schedule_state.yaml +
 *      trigger_state.yaml pattern.
 *   2. `genSecret` — `crypto.randomBytes(32).toString('hex')` returning the
 *      64-char lowercase hex string used for HMAC-SHA256 signing keys. The
 *      caller embeds it via a `literal:<hex>` URI so the runtime's secret
 *      resolver (post-`literalBackend()` registration) reads it back.
 *   3. `defaultWebhooksPath` / `defaultWebhookPort` — `~/.opensquid/
 *      webhooks.yaml` + `8765` matching `DEFAULT_WEBHOOK_PORT` in
 *      `src/runtime/daemon.ts`.
 *
 * Secret-handling discipline (audit-critical):
 *
 *   We DO NOT use the runtime `SecretResolver` here. The CLI is the
 *   authoritative writer of inline-literal subscriptions; introducing
 *   resolver indirection in the CLI write path would couple the CLI to
 *   the resolver's env-var / 1Password backends and break the locked
 *   "write new secret to webhooks.yaml BEFORE invalidating old" atomic
 *   rotation contract. The `secret:` field is stored as the URI
 *   `literal:<64-hex>` directly — readers (CLI + daemon) get the hex by
 *   either stripping the `literal:` prefix (CLI) or routing through the
 *   resolver with `literalBackend()` registered (daemon, configured at
 *   setup time outside this task's scope).
 *
 * Imports from: node:crypto, node:fs/promises, yaml, ../../runtime/paths.
 * Imported by: src/setup/cli/webhooks.ts + src/setup/cli/webhooks_actions.ts.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { OPENSQUID_HOME } from '../../runtime/paths.js';

/** CLI-managed shape mirrors the SCHED.1 `SubscriptionYaml` exactly. */
export interface SubscriptionRecord {
  id: string;
  pack: string;
  /** Required unless deliver_only is true. */
  skill?: string;
  /** URI for the SecretResolver. CLI writes `literal:<64-hex>`. */
  secret: string;
  /** SCHED.2 zero-LLM mode flag. Default false on disk; we never write
   *  `deliver_only: false` explicitly to keep skill-mode YAML clean. */
  deliver_only?: boolean;
  template?: string;
  deliver_to?: string;
  severity?: 'critical' | 'error' | 'warning' | 'info';
  rate_limit?: { max: number; per: 'minute' | 'hour' | 'day' };
  /** ISO-8601 timestamps the CLI stamps for audit. Daemon ignores. */
  created_at?: string;
  rotated_at?: string;
}

export const defaultWebhooksPath = (): string => join(OPENSQUID_HOME(), 'webhooks.yaml');

/** Mirrors `DEFAULT_WEBHOOK_PORT` in `src/runtime/daemon.ts`. */
export const defaultWebhookPort = (): number => 8765;

/** Generate a 64-char lowercase hex HMAC-SHA256 signing key (32 bytes). */
export function genSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Compose the `literal:` URI the CLI persists into `secret:`. */
export function literalSecretUri(hex: string): string {
  return `literal:${hex}`;
}

/** Strip a `literal:` prefix; returns the URI unchanged if not literal. */
export function unwrapLiteralSecret(uri: string): { literal: boolean; value: string } {
  if (uri.startsWith('literal:')) return { literal: true, value: uri.slice('literal:'.length) };
  return { literal: false, value: uri };
}

/** Canonical `http://localhost:<port>/webhook/<id>` URL — daemon route. */
export function webhookUrl(id: string, port: number): string {
  return `http://localhost:${String(port)}/webhook/${id}`;
}

export async function readWebhooksFile(path: string): Promise<SubscriptionRecord[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(
      `webhooks.yaml is malformed (${path}): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || parsed === undefined) return [];
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`webhooks.yaml must be a mapping (${path})`);
  }
  const list = (parsed as { subscriptions?: unknown }).subscriptions;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    throw new Error(`webhooks.yaml: \`subscriptions\` must be a list (${path})`);
  }
  return list.filter((s): s is SubscriptionRecord => typeof s === 'object' && s !== null);
}

/**
 * Atomic write — `tmp + rename`. The `tmp` file is in the same directory
 * so `rename` stays on one filesystem (atomicity guarantee on POSIX).
 *
 * Callers MUST pass the FULL desired subscription set; we never merge
 * here because partial writes risk dropping unrelated subscriptions on
 * concurrent CLI invocations.
 */
export async function writeWebhooksFile(
  path: string,
  subscriptions: readonly SubscriptionRecord[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body =
    subscriptions.length === 0
      ? 'subscriptions: []\n'
      : stringifyYaml({ subscriptions: [...subscriptions] });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

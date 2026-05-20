/**
 * Webhook subscription loader — reads `~/.opensquid/webhooks.yaml` and
 * resolves declared secrets through the user's configured `SecretResolver`.
 *
 * Authoritative source: `docs/tasks/scheduling.md` SCHED.1 "Key code shapes"
 * + memory `project_opensquid_file_organization` (one concern per file).
 *
 * The YAML lives outside any pack — it's user-config, not codex-content —
 * because the same opensquid install routes webhooks for many packs. Pack
 * authors declare a `triggers: [{kind: webhook, path: ...}]` block, and the
 * user wires the secret + rate-limit + deliver_only flags here.
 *
 * Resolved-secret discipline (locked, audit-critical):
 *
 *   The resolved `signingSecret` lives ONLY in memory on a `Subscription`
 *   instance. We never write it back to disk, never log it (toString-safe
 *   error messages everywhere), and the field is a string-typed property
 *   without any JSON-serializing helper. Hosts that want to dump the
 *   subscriptions table for debugging MUST funnel through `redact()` (below)
 *   which substitutes `[REDACTED]` for the secret slot.
 *
 * URI shape: anything the resolver understands. We accept three common
 * dialects so the YAML reads naturally:
 *
 *   secret: "env:STRIPE_WEBHOOK_SECRET"          (env-var)
 *   secret: "op://Personal/github-webhook/secret" (1Password CLI)
 *   secret: "keychain:GH_WH_TOKEN"                 (macOS keychain)
 *
 * If the URI resolves to `null` (backend missing the secret), we throw a
 * structured `WebhookSubscriptionError` naming the subscription id + URI
 * scheme — never the URI itself, which on the `env:` path would surface the
 * env-var name (low risk but still avoidable noise).
 *
 * Imports from: node:fs/promises, yaml, ../secrets/index.js, zod.
 * Imported by: src/runtime/daemon.ts.
 */

import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import type { SecretResolver } from '../secrets/index.js';

// ---------------------------------------------------------------------------
// YAML schema — the on-disk shape. Authors hand-write this; we Zod-parse so
// typos surface at load time, not at HMAC-verify time mid-request.
// ---------------------------------------------------------------------------

const RateLimitSpec = z.object({
  max: z.number().int().positive(),
  per: z.enum(['minute', 'hour', 'day']),
});

const SubscriptionYaml = z
  .object({
    id: z.string().min(1),
    pack: z.string().min(1),
    skill: z.string().min(1),
    /** URI handed to the SecretResolver (e.g. `env:STRIPE_WEBHOOK_SECRET`). */
    secret: z.string().min(1),
    /** SCHED.2 zero-LLM path. SCHED.1 ships the field but never consults it. */
    deliver_only: z.boolean().default(false),
    rate_limit: RateLimitSpec.optional(),
  })
  .strict();

const WebhookSubscriptionsFile = z
  .object({
    subscriptions: z.array(SubscriptionYaml).default([]),
  })
  .strict();

export type SubscriptionYaml = z.infer<typeof SubscriptionYaml>;

// ---------------------------------------------------------------------------
// Runtime view — secret URI replaced by RESOLVED value. Stays in memory.
// ---------------------------------------------------------------------------

export interface Subscription {
  id: string;
  pack: string;
  skill: string;
  /** Resolved HMAC-SHA256 signing key. NEVER log, NEVER persist. */
  signingSecret: string;
  deliverOnly: boolean;
  rateLimit?: { max: number; per: 'minute' | 'hour' | 'day' };
}

export class WebhookSubscriptionError extends Error {
  constructor(
    message: string,
    readonly subscriptionId?: string,
  ) {
    super(message);
    this.name = 'WebhookSubscriptionError';
  }
}

/**
 * Parse + secret-resolve a webhooks.yaml file. Missing file is NOT an error
 * — the daemon still boots with an empty subscription set so cron-only
 * deployments don't need to author this YAML at all.
 *
 * Throws WebhookSubscriptionError on:
 *   - YAML / schema validation failure (typo in field name, wrong type).
 *   - duplicate `id` across subscriptions (would route ambiguously).
 *   - secret URI that resolves to null (backend missing the key).
 */
export async function loadWebhookSubscriptions(
  path: string,
  resolver: SecretResolver,
): Promise<Subscription[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new WebhookSubscriptionError(
      `failed to read webhook subscriptions at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new WebhookSubscriptionError(
      `failed to parse webhook subscriptions YAML at ${path}: ${(err as Error).message}`,
    );
  }

  const validated = WebhookSubscriptionsFile.safeParse(parsed ?? {});
  if (!validated.success) {
    throw new WebhookSubscriptionError(
      `webhook subscriptions YAML at ${path} failed validation: ${validated.error.message}`,
    );
  }

  const seen = new Set<string>();
  const out: Subscription[] = [];
  for (const sub of validated.data.subscriptions) {
    if (seen.has(sub.id)) {
      throw new WebhookSubscriptionError(
        `duplicate webhook subscription id "${sub.id}" in ${path}`,
        sub.id,
      );
    }
    seen.add(sub.id);

    const resolved = await resolver.resolve(sub.secret);
    if (resolved === null || resolved === '') {
      // Surface scheme only — never the ref. `env:FOO` becomes `env:...`.
      const colon = sub.secret.indexOf(':');
      const scheme = colon > 0 ? sub.secret.slice(0, colon) : '<unknown>';
      throw new WebhookSubscriptionError(
        `webhook subscription "${sub.id}" secret could not be resolved via "${scheme}:" backend`,
        sub.id,
      );
    }

    out.push({
      id: sub.id,
      pack: sub.pack,
      skill: sub.skill,
      signingSecret: resolved,
      deliverOnly: sub.deliver_only,
      ...(sub.rate_limit ? { rateLimit: sub.rate_limit } : {}),
    });
  }
  return out;
}

/**
 * Redacted view for audit logs + debug dumps. Mirrors the Subscription shape
 * but substitutes `[REDACTED]` for the secret slot. This is the only safe
 * way to surface a subscription set in a log line.
 */
export function redact(sub: Subscription): Omit<Subscription, 'signingSecret'> & {
  signingSecret: '[REDACTED]';
} {
  return {
    id: sub.id,
    pack: sub.pack,
    skill: sub.skill,
    signingSecret: '[REDACTED]',
    deliverOnly: sub.deliverOnly,
    ...(sub.rateLimit ? { rateLimit: sub.rateLimit } : {}),
  };
}

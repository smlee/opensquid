/**
 * Zod schema for `notifications.yaml` — the pack's severity → channel routing.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Notification routing"
 * + memory `project_opensquid_notification_routing`.
 *
 * Routing is deterministic code (NOT LLM-judged): given a notification's
 * severity + project, look up which abstract channels receive it. Severity
 * has four tiers (`critical | error | warning | info`); each tier maps to a
 * list of abstract channel names; per-project overrides win when present.
 *
 * Channel names in this file are ABSTRACT — they reference the pack-declared
 * names from `channels.yaml`. Concrete URI resolution happens at the channel
 * adapter layer (user-config-driven). This split keeps packs portable across
 * users with different channel layouts.
 *
 * `.strict()` is applied — only `severity_tiers` + `per_project_override` are
 * valid top-level keys. Typos like `severity_tier` would silently noop without
 * `.strict()`, which is dangerous for a routing file where misconfiguration
 * means silent message loss.
 *
 * Defaults match design doc §"Routing schema" example: critical + error go to
 * `alerts`; warning + info go to `chat`. The `alerts` abstract name must be
 * mapped by user config; if unmapped, the channel adapter falls back per the
 * design doc §"Fallback chain".
 *
 * Imports from: zod only (self-contained per audit constraint).
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Severity — four tiers per design doc §"Notification routing".
//
// Ordering (high → low): critical, error, warning, info. The runtime emits
// the tier when surfacing a verdict + notification; this schema only
// validates the routing map shape.
// ---------------------------------------------------------------------------

export const Severity = z.enum(['critical', 'error', 'warning', 'info']);
export type Severity = z.infer<typeof Severity>;

// ---------------------------------------------------------------------------
// SeverityTiersMap — every severity maps to a list of abstract channels.
//
// `.partial()` is intentional — packs may declare only some tiers; missing
// tiers fall through to the fallback chain. Each tier's value is the LIST
// of channels (multicast: a critical message can go to multiple destinations
// simultaneously).
// ---------------------------------------------------------------------------

const SeverityTiersMap = z.record(Severity, z.array(z.string()));

// ---------------------------------------------------------------------------
// NotificationsConfig — top-level shape of `notifications.yaml`.
//
// `severity_tiers` — global default routing.
// `per_project_override` — project name → severity-tier map. The runtime
// looks up the current project ID and prefers its override when present.
// ---------------------------------------------------------------------------

export const NotificationsConfig = z
  .object({
    severity_tiers: SeverityTiersMap.default({
      critical: ['alerts'],
      error: ['alerts'],
      warning: ['chat'],
      info: ['chat'],
    }),
    per_project_override: z.record(z.string(), SeverityTiersMap).default({}),
  })
  .strict();
export type NotificationsConfig = z.infer<typeof NotificationsConfig>;

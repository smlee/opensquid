/**
 * Zod schema for `manifest.yaml` — the pack's identity file.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Manifest fields" +
 * §"Minimum-viable pack example". Four fields are required (name + version +
 * scope + goal); everything else has a documented default per the
 * out-of-the-box constraint (`project_opensquid_out_of_the_box`).
 *
 * This schema is the YAML-loading counterpart to `runtime/types.ts`'s `Pack`
 * type — that runtime shape models the parsed-and-merged pack (manifest +
 * skills + sidecar config), while `Manifest` here validates only the raw
 * `manifest.yaml` document. Skills live in their own files (skill.ts), so
 * `skills: []` is intentionally absent from this schema.
 *
 * `.strict()` is intentional — a typo like `versoin: 0.1.0` should fail loudly
 * at load, not silently default to `version: undefined`. The risk callout in
 * the spec singles this out: among the six pack-config files, manifest is the
 * one where field-name correctness matters most because the four required
 * fields drive load-time semantics (scope-based ordering, goal text feeding
 * destination-check, name keying conflict resolution).
 *
 * Semver regex is loose (`^\d+\.\d+\.\d+`) on purpose. Tighter validation via
 * `semver.valid()` is deferred to audit if false-positives surface in practice
 * (spec risk callout). The `name` regex blocks digit-leading + uppercase +
 * non-hyphen punctuation; the setup UI is the place to surface user-friendly
 * errors when these reject.
 *
 * Imports from: zod only (self-contained per audit constraint).
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Scope — five values per design doc §"Manifest fields"
//
// `universal` = applies everywhere; `domain` = a class of work (e.g. coding,
// research); `specialty` = a sub-discipline (e.g. Rust, frontend); `workflow`
// = a process pattern (e.g. ship-verified-work); `project` = one repo / one
// tenant. Ordering is unenforced at schema layer — pack-resolution code in
// Task 2.3+ handles precedence.
// ---------------------------------------------------------------------------

export const ManifestScope = z.enum(['universal', 'domain', 'specialty', 'workflow', 'project']);
export type ManifestScope = z.infer<typeof ManifestScope>;

// ---------------------------------------------------------------------------
// Rate limits — pack-declared per-trigger caps enforced by `RateLimiter`
// (AUTO.2). Keyed by the same `TriggerKind` literals from `runtime/event.ts`
// so a typo (`per: "5 minutes"`, `webhok: ...`) fails the `.strict()` /
// enum validators at load instead of silently defaulting to unlimited.
//
// Per-trigger config: `max` and `per` are required; `concurrent` defaults
// to "no cap". The `per` enum is sealed at `minute|hour|day` — anything
// finer is out-of-scope for AUTO.2 (the dispatch sources fire at second
// granularity at the fastest, and an explicit enum rejects authoring
// mistakes loudly).
//
// Block-missing semantics: undefined → unlimited for every trigger (no
// regression for any Phase 1–7 pack authored before AUTO.2). Per-trigger
// keys are also individually optional inside the block — a pack can
// declare only `schedule:` and leave `webhook:` unlimited.
// ---------------------------------------------------------------------------

export const RateLimitPeriod = z.enum(['minute', 'hour', 'day']);
export type RateLimitPeriod = z.infer<typeof RateLimitPeriod>;

const RateLimitTriggerConfig = z
  .object({
    max: z.number().int().positive(),
    per: RateLimitPeriod,
    concurrent: z.number().int().positive().optional(),
  })
  .strict();
export type RateLimitTriggerConfig = z.infer<typeof RateLimitTriggerConfig>;

export const RateLimits = z
  .object({
    tool_call: RateLimitTriggerConfig.optional(),
    prompt_submit: RateLimitTriggerConfig.optional(),
    session_end: RateLimitTriggerConfig.optional(),
    stop: RateLimitTriggerConfig.optional(),
    schedule: RateLimitTriggerConfig.optional(),
    webhook: RateLimitTriggerConfig.optional(),
    inbound_channel: RateLimitTriggerConfig.optional(),
    file_changed: RateLimitTriggerConfig.optional(),
  })
  .strict();
export type RateLimits = z.infer<typeof RateLimits>;

// ---------------------------------------------------------------------------
// Manifest — the document shape.
//
// `extends` is genuinely optional (no sensible default — most packs don't
// extend), so it stays `.optional()` without a `.default(...)`. Every other
// optional field has a concrete default so the out-of-the-box "minimum-viable
// 4-field pack" parses with no surprises.
// ---------------------------------------------------------------------------

export const Manifest = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase alphanum + hyphens, no leading hyphen/digit-only'),
    version: z.string().regex(/^\d+\.\d+\.\d+/, 'semver-shaped (MAJOR.MINOR.PATCH prefix)'),
    scope: ManifestScope,
    goal: z.string().min(1),
    description: z.string().default(''),
    requires: z.array(z.string()).default([]),
    conflicts: z.array(z.string()).default([]),
    extends: z.string().optional(),
    evolves: z.boolean().default(true),
    // AUTO.2: optional `rate_limits:` block. Block absent → unlimited for
    // every trigger (back-compat with every Phase 1–7 pack). Block present
    // → only the declared trigger keys are limited; others remain unlimited.
    rate_limits: RateLimits.optional(),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

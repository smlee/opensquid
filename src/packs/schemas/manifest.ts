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
// Permissions (AUTO.3) — pack-declared capability allowlists. Per-capability
// blocks declare allowlist scopes (commands / domains / paths / channels /
// binaries) plus an optional pack-local `deny:` adding to the built-in
// denylist (which ALWAYS wins unless `OPENSQUID_TRUST_BUILTIN_DENY=0`).
//
// Block-missing semantics: undefined `permissions:` → deny-all for every
// capability (locked decision — packs MUST declare what they need; silent
// fail-open is constraint C10). Inside the block, every per-capability key
// is individually optional — a pack that only does `file_write` declares
// only `file_write:` and leaves the rest at deny.
//
// Glob semantics: allowlist + pack-local `deny:` patterns are minimatch
// globs for shell commands (matched against PARSED argv joined with " "),
// file paths, channels, and binary names. `http_request.domains:` is the
// ONE exception — entries are hostname-exact OR leading-`*.` subdomain
// match, NEVER raw-URL glob (per spec risk callout: `api.github.com.evil.com`
// must NOT match `api.github.com`).
//
// `.strict()` on every block — typos like `commadns:` / `domian:` fail
// loudly at load (same posture as the rest of the manifest schema).
// ---------------------------------------------------------------------------

export const Capability = z.enum([
  'shell_exec',
  'http_request',
  'file_write',
  'send_message',
  'subprocess_call',
  // AUTO.4: invoking another skill's process from inside the runtime (e.g.
  // an `auto_correct` policy invoking the pack's declared corrective skill).
  // `targets:` is an allowlist of skill names; `*` matches all.
  'subagent_call',
]);
export type Capability = z.infer<typeof Capability>;

const ShellExecPermission = z
  .object({
    commands: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const HttpRequestPermission = z
  .object({
    domains: z.array(z.string().min(1)).default([]),
    methods: z.array(HttpMethod).default(['GET']),
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

const FileWritePermission = z
  .object({
    paths: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

const SendMessagePermission = z
  .object({
    channels: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

const SubprocessCallPermission = z
  .object({
    binaries: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

// AUTO.4: subagent_call permits invoking another skill's process from inside
// the runtime. `targets:` is a list of skill names (minimatch globs); `*`
// matches every skill. Used by the `auto_correct` drift policy to gate
// invocation of the pack's declared corrective skill before any process step
// runs (fail-early per spec risk callout).
const SubagentCallPermission = z
  .object({
    targets: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const Permissions = z
  .object({
    shell_exec: ShellExecPermission.optional(),
    http_request: HttpRequestPermission.optional(),
    file_write: FileWritePermission.optional(),
    send_message: SendMessagePermission.optional(),
    subprocess_call: SubprocessCallPermission.optional(),
    subagent_call: SubagentCallPermission.optional(),
  })
  .strict();
export type Permissions = z.infer<typeof Permissions>;
export type ShellExecPermission = z.infer<typeof ShellExecPermission>;
export type HttpRequestPermission = z.infer<typeof HttpRequestPermission>;
export type FileWritePermission = z.infer<typeof FileWritePermission>;
export type SendMessagePermission = z.infer<typeof SendMessagePermission>;
export type SubprocessCallPermission = z.infer<typeof SubprocessCallPermission>;
export type SubagentCallPermission = z.infer<typeof SubagentCallPermission>;

// ---------------------------------------------------------------------------
// IDF.1 (2026-05-30) — Foundation taxonomy + ActivationScope + DetectedByCheck
//
// Per T-IDENTITY-FOUNDATION Phase 1. Restores three v0.6 codex content-richness
// fields that the lean-iteration dropped but user 2026-05-29 locked back as
// v1 targets. All additive: existing packs parse unchanged (every field
// optional with sensible default).
// ---------------------------------------------------------------------------

// Foundation taxonomy (v0.6 §4.2) — three optional sub-fields describing
// what the pack KNOWS. Descriptive at IDF.1; Phase 2 will consume for
// taxonomic matching + marketplace search.
const FoundationTool = z
  .object({
    name: z.string().min(1),
    semver: z.string().optional(),
  })
  .strict();

export const Foundation = z
  .object({
    tools: z.array(FoundationTool).default([]),
    domains: z.array(z.string().min(1)).default([]),
    methodologies: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type Foundation = z.infer<typeof Foundation>;

// ActivationScope (v0.6 §4.5) — WHERE the pack applies. Distinct from `scope:`
// (which is LAYERING precedence universal→domain→specialty→workflow→project).
// Default 'project' matches today's implicit per-cwd behavior.
export const ActivationScope = z.enum(['project', 'user', 'hybrid', 'team', 'global']);
export type ActivationScope = z.infer<typeof ActivationScope>;

// DetectedByCheck (v0.6 §4.4) — 7-kind discriminated union for WHEN the
// pack auto-activates. Per [[feedback_stop_haiku_drift]]: no LLM in
// detection — pure filesystem + memory + prompt-substring regex.
const FileExistsCheck = z
  .object({
    kind: z.literal('file_exists'),
    path: z.string().min(1),
  })
  .strict();
const DirExistsCheck = z
  .object({
    kind: z.literal('dir_exists'),
    path: z.string().min(1),
  })
  .strict();
const FileMatchCheck = z
  .object({
    kind: z.literal('file_match'),
    path: z.string().min(1),
    matches: z.record(z.string(), z.string()),
  })
  .strict();
const FileGlobCheck = z
  .object({
    kind: z.literal('file_glob'),
    pattern: z.string().min(1),
    min_count: z.number().int().positive().default(1),
  })
  .strict();
const MemoryMatchCheck = z
  .object({
    kind: z.literal('memory_match'),
    pattern: z.string().min(1),
  })
  .strict();
const ConversationSignalCheck = z
  .object({
    kind: z.literal('conversation_signal'),
    pattern: z.string().min(1),
  })
  .strict();
const UserPinnedCheck = z
  .object({
    kind: z.literal('user_pinned'),
  })
  .strict();

export const DetectedByCheck = z.discriminatedUnion('kind', [
  FileExistsCheck,
  DirExistsCheck,
  FileMatchCheck,
  FileGlobCheck,
  MemoryMatchCheck,
  ConversationSignalCheck,
  UserPinnedCheck,
]);
export type DetectedByCheck = z.infer<typeof DetectedByCheck>;

// ---------------------------------------------------------------------------
// MM.1 (2026-05-30) — Pack kind (v0.6 §4.7).
//   - 'focused'   = own content + own foundation + own detected_by + own skills.
//                    The default; covers every pre-MM.1 pack.
//   - 'composite' = pure aggregator. References focused packs via `includes:`,
//                    must NOT declare own `foundation:` or own skills' content
//                    (the superRefine on Manifest enforces).
// 2-value enum per L2 — no third path.
// ---------------------------------------------------------------------------

export const PackKind = z.enum(['focused', 'composite']);
export type PackKind = z.infer<typeof PackKind>;

// ---------------------------------------------------------------------------
// MM.1 — Pack usage mode.
//   - 'active'     = loads into parent agent's mind; rules fire via dispatcher.
//                     The default; covers every pre-MM.1 pack.
//   - 'profession' = spawned as a subagent via the `spawn_subagent` primitive
//                     when a directive verdict's `next_action.profession`
//                     references it. REQUIRES `team.yaml` at the pack root
//                     (loader-side check; not enforced at this schema layer).
//   - 'both'       = eligible for either load path.
// Per L8: profession-mode packs MUST also be `kind: focused` (composites have
// no team.yaml). The loader enforces this; this schema does not (would require
// a cross-field refine that's clearer in the loader).
// ---------------------------------------------------------------------------

export const PackUsage = z.enum(['active', 'profession', 'both']);
export type PackUsage = z.infer<typeof PackUsage>;

// ---------------------------------------------------------------------------
// MM.1 — Composite-pack include entry. Each entry pins a focused pack by
// name + a semver range. Resolution happens at load time against the
// discovered focused-pack registry (composite_resolver.ts).
// `.strict()` rejects typos (`pack_name:` instead of `pack_id:`).
// ---------------------------------------------------------------------------

export const CompositeInclude = z
  .object({
    pack_id: z.string().min(1),
    semver: z.string().min(1),
  })
  .strict();
export type CompositeInclude = z.infer<typeof CompositeInclude>;

// ---------------------------------------------------------------------------
// LP.1 (2026-05-30) — BaseVersion + PersonalRevision.
//
// BaseVersion = semver string identifying the immutable vanilla baseline a
// pack was installed at. Set once at install (LP.4); never mutated by the
// engine. PersonalRevision = the version.json shape stored at
// `~/.opensquid/packs/<pack-id>/personal_revision/version.json` — the
// runtime-mutated state companion to the immutable base_version.
//
// Schema validates SUBSET of full semver (no +build metadata, simplified
// prerelease grammar) — sufficient for v1 pack authors using `1.2.3` or
// `1.2.3-rc.1` shapes. Full semver validation via `semver` npm package is
// overkill at the schema layer.
// ---------------------------------------------------------------------------

export const BaseVersion = z.string().regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/, {
  message: 'base_version must be valid semver (e.g. "1.2.3" or "1.2.3-rc.1")',
});
export type BaseVersion = z.infer<typeof BaseVersion>;

export const PersonalRevision = z
  .object({
    base_version: BaseVersion,
    personal_revision_id: z.number().int().nonnegative().default(0),
    last_merged_vanilla: BaseVersion.nullable().default(null),
  })
  .strict();
export type PersonalRevision = z.infer<typeof PersonalRevision>;

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
    // AUTO.3: optional `permissions:` block declaring per-capability
    // allowlists. Block absent → deny-all for every capability (NOT back-
    // compat — packs that exercise capabilities MUST declare them). The
    // gate (`src/runtime/capability_gate.ts`) reads this block at check
    // time; the built-in denylist (`src/runtime/builtin_denylist.ts`) is
    // applied first and ALWAYS wins unless `OPENSQUID_TRUST_BUILTIN_DENY=0`.
    permissions: Permissions.optional(),
    // IDF.1 (2026-05-30) — v0.6 codex content-richness restored as
    // additive optional fields. See Foundation / ActivationScope /
    // DetectedByCheck schemas above. Foundation undefined when absent;
    // activation_scope defaults to 'project' (matches current implicit
    // per-cwd behavior); detected_by defaults to [] (empty array =
    // "applies always" per IDF.2 evaluator semantic).
    foundation: Foundation.optional(),
    activation_scope: ActivationScope.default('project'),
    detected_by: z.array(DetectedByCheck).default([]),
    // MM.1 (2026-05-30) — pack kind + usage + composite includes.
    // All three have sensible defaults so every pre-MM.1 pack parses unchanged:
    // 'focused' / 'active' / [] mirror today's implicit single-mode behavior.
    kind: PackKind.default('focused'),
    usage: PackUsage.default('active'),
    includes: z.array(CompositeInclude).default([]),
    // LP.1 (2026-05-30) — loader-populated, not author-declared. A pack
    // author NEVER puts base_version/personal_revision in manifest.yaml
    // directly; the LP.4 install command writes them into
    // ~/.opensquid/packs/<name>/personal_revision/version.json and the
    // loader hoists into Pack. Schema accepts them as optional for
    // in-memory consistency.
    base_version: BaseVersion.optional(),
    personal_revision: PersonalRevision.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    // MM.1 cross-field invariants.
    // focused ⇒ no includes (only composites aggregate)
    if (m.kind === 'focused' && m.includes.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includes'],
        message: `pack ${m.name}: kind: focused MUST have empty includes (got ${String(m.includes.length)} entries) — composites aggregate; focused packs own content`,
      });
    }
    // composite ⇒ non-empty includes (a composite with no includes is malformed)
    if (m.kind === 'composite' && m.includes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['includes'],
        message: `pack ${m.name}: kind: composite REQUIRES non-empty includes — a composite with no includes is a configuration error`,
      });
    }
    // composite ⇒ no own foundation (pure aggregator per v0.6 §4.7)
    if (m.kind === 'composite' && m.foundation !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['foundation'],
        message: `pack ${m.name}: kind: composite MUST NOT declare foundation — composites are pure aggregators with no own content (v0.6 §4.7)`,
      });
    }
    // composite + detected_by IS allowed — gates WHEN to expand includes per L12.
  });
export type Manifest = z.infer<typeof Manifest>;

/**
 * Zod schema for `models.yaml` — the pack's model-alias declarations.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Five LLM call modes"
 * + §"models.yaml shape" + memory `project_opensquid_model_neutral_subagent_primitive`.
 *
 * Packs declare task-purpose aliases (`fast_classifier`, `reasoning`, etc.) +
 * suggested implementations; user config overrides at `~/.opensquid/models.yaml`.
 * Rules NEVER reference a concrete model by name — they go through aliases.
 * This schema validates the alias map; per-alias semantics (e.g. `cli` is
 * required when `mode=subscription` + `impl=cli`) are NOT enforced here —
 * they belong to a higher-level cross-field check in Task 2.4 once the
 * alias resolver lands.
 *
 * `.passthrough()` is NOT applied; the alias object stays as-is (default
 * permissive) because future modes may want extra fields. We keep this
 * permissive at the schema layer per the spec "Skill permissive on opaque
 * fields" pattern — model adapters land in later phases.
 *
 * `ModelsConfig` is `z.record(string, ModelAlias).default({})` so an empty
 * `models.yaml` (or no `models.yaml` at all) parses to `{}` — see the
 * out-of-the-box constraint that an empty user config must validate.
 *
 * Imports from: zod only (self-contained per audit constraint).
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// ModelMode — five call modes per design doc §"Five LLM call modes" table.
//
// `subscription` (cli + sdk impls), `api`, `local`, `mcp`. The `impl` field
// is only meaningful for `subscription` mode (cli subprocess vs in-process
// SDK); other modes ignore it. We keep `impl` optional + permissive rather
// than building a discriminated union — Phase 1 doesn't need the precision,
// and a discriminated union would explode the schema LOC.
// ---------------------------------------------------------------------------

export const ModelMode = z.enum(['subscription', 'api', 'local', 'mcp']);
export type ModelMode = z.infer<typeof ModelMode>;

export const ModelImpl = z.enum(['cli', 'sdk']);
export type ModelImpl = z.infer<typeof ModelImpl>;

// ---------------------------------------------------------------------------
// ModelAlias — one alias declaration.
//
// Every field except `mode` is optional because different modes need different
// fields (subscription+cli needs `cli` + `args`; api needs `endpoint`; mcp
// needs `server` + `tool`; etc.). Cross-field validation deferred to the
// resolver layer.
// ---------------------------------------------------------------------------

export const ModelAlias = z.object({
  description: z.string().default(''),
  mode: ModelMode,
  impl: ModelImpl.optional(),
  cli: z.string().optional(),
  args: z.array(z.string()).default([]),
  sdk: z.string().optional(),
  model: z.string().optional(),
  endpoint: z.string().url().optional(),
  provider: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
});
export type ModelAlias = z.infer<typeof ModelAlias>;

// ---------------------------------------------------------------------------
// ModelsConfig — the whole `models.yaml` document: alias_name → ModelAlias.
//
// Empty record is valid (`{}`) — packs that don't need any LLM aliases (pure
// deterministic track-checks, no destination-check) skip this file entirely.
// ---------------------------------------------------------------------------

export const ModelsConfig = z.record(z.string(), ModelAlias).default({});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

/**
 * `spawn_subagent` primitive — Mode A team orchestration entry point.
 *
 * Per `docs/opensquid-real-design.md` §"Team modes" Mode A + memory
 * `project_opensquid_team_modes` (Mode A = one agent + Agent-tool subagents
 * for profession-instantiation; Mode B = multi-tenant, future).
 *
 * Surface (per Task 6.2 key code shape):
 *
 *   spawn_subagent({ model, prompt, context }) → ok({ stdout, drifts[] })
 *
 *   - `model`        : model alias (USER-supplied label, NOT a vendor model
 *                      id; resolved against the active `models.yaml` by the
 *                      caller before reaching this primitive). The primitive
 *                      itself stays model-neutral — no vendor names in this
 *                      file.
 *   - `prompt`       : the subagent's initial prompt.
 *   - `context`      : optional `{ project?, profession? }`. Used by the
 *                      context-inheritance filter (Task 6.3) AND wired into
 *                      drift roll-up provenance (Task 6.4). Anything beyond
 *                      these two fields is intentionally rejected by the
 *                      Zod schema — leakage of parent session secrets MUST
 *                      NOT travel via arbitrary `context` bag.
 *
 * SDK call mode (per Task 6.2 acceptance criteria):
 *
 *   In-process Claude Agent SDK is the required mode (it's the only path
 *   that can observe the parent session — see memory
 *   `project_opensquid_model_neutral_subagent_primitive`).
 *
 *   The SDK (`@anthropic-ai/claude-agent-sdk`) is loaded LAZILY via
 *   `await import(...)` so a missing dep doesn't crash startup — the setup
 *   UI verifies presence later. If a pack actually invokes `spawn_subagent`
 *   without the SDK installed, the dynamic import throws and we surface
 *   `err({ kind: 'runtime' })` with the import error as cause.
 *
 *   The SDK package is declared as an OPTIONAL peer dep in package.json so
 *   `pnpm install` won't fail when it isn't present in the user's env.
 *
 * Test seam (`opts.sdk`):
 *
 *   Tests inject a stub SDK via `registerSubagentFunction(registry, { sdk })`
 *   to avoid requiring the real package + to assert the primitive's contract
 *   (input shape, return shape, error mapping). The default — no `opts.sdk`
 *   — falls back to the lazy dynamic import path used in production.
 *
 *   The seam is intentionally NOT a runtime override path that pack YAML can
 *   reach: the only way to plug a stub is via the registration helper, which
 *   pack-loading code does not call with `opts.sdk`. The seam exists for
 *   tests only.
 *
 * Model neutrality (per `feedback_stop_haiku_drift` + memory
 * `project_opensquid_model_neutral_subagent_primitive`): NO vendor model
 * name appears in this file. A grep for `claude` / `haiku` / `opus` /
 * `sonnet` / `gpt` should return zero hits. Treat any future addition as a
 * regression — the model alias is the only abstraction.
 *
 * Drift roll-up (Task 6.4):
 *
 *   When the subagent returns `drifts`, this primitive ALSO writes them to
 *   the parent's session-level drift catalog via `recordSubagentDrifts`
 *   (drift_catalog.ts). The subagent's own pack catalog is written by the
 *   SDK-side evaluator during its run; we do not double-write that path
 *   here. See `recordSubagentDrifts` for the provenance enrichment policy.
 *
 *   The subagent id is generated per-call (`subagent-<random>`) so two
 *   simultaneous spawns under the same profession pack remain distinguishable
 *   in the catalog. The `professionPack` comes from `context.profession`,
 *   falling back to a sentinel when the caller omits it.
 *
 *   The parent session id comes from `EvalCtx.sessionId` — the primitive
 *   runs inside the parent's evaluation context, so by construction the
 *   write target is the parent's catalog, never the subagent's own session.
 *
 * Imports from: zod, ../runtime/result.js, ../runtime/drift_catalog.js,
 *               ./registry.js.
 * Imported by: src/functions/index.ts, src/runtime/bootstrap.ts.
 */

import { z } from 'zod';

import { recordSubagentDrifts } from '../runtime/drift_catalog.js';
import { err, ok } from '../runtime/result.js';

import type { FunctionRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// SubagentDrift — the SDK's drift event shape (best-effort partial — the
// SDK is treated as untrusted input at this boundary).
//
// Kept loose (all fields optional / unknown-typed at runtime) because the
// SDK's drift surface may evolve. Normalization to a strict `DriftEvent`
// happens at the catalog write boundary.
// ---------------------------------------------------------------------------

export interface SubagentDrift {
  timestamp?: string;
  pack?: string;
  ruleId?: string;
  level?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// SubagentSdk — minimal contract the SDK (or a test stub) must satisfy.
//
// Modeled after the documented Claude Agent SDK surface for in-process runs
// but kept narrow: this primitive only needs `runAgent` to return a text
// + optional drift list. The real SDK exposes more (streaming, tools,
// permissions); we don't depend on any of that here, so a stub only has to
// implement `runAgent`.
// ---------------------------------------------------------------------------

export interface SubagentSdkRunResult {
  text: string;
  drifts?: SubagentDrift[];
}

export interface SubagentSdk {
  runAgent: (opts: {
    model: string;
    prompt: string;
    context: Record<string, unknown>;
  }) => Promise<SubagentSdkRunResult>;
}

// ---------------------------------------------------------------------------
// SpawnSubagentArgs — Zod schema for primitive args.
//
// `context` is OPTIONAL + STRICT: only `project` + `profession` are allowed
// fields, matching the context-inheritance contract (Task 6.3). A pack that
// tries to pass other context fields gets `arg_invalid` so leakage paths
// can't be opened by accident from YAML.
// ---------------------------------------------------------------------------

const SpawnSubagentArgs = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  context: z
    .object({
      project: z.string().optional(),
      profession: z.string().optional(),
    })
    .strict()
    .optional(),
});

// ---------------------------------------------------------------------------
// SpawnSubagentResult — what the primitive returns on success.
//
// `stdout` is the subagent's final assistant-visible text. `drifts` is the
// (possibly empty) normalized list surfaced by the subagent during its run.
// Phase 6.4 wires roll-up to the parent's session catalog with provenance.
// ---------------------------------------------------------------------------

export interface SpawnSubagentResult {
  stdout: string;
  drifts: SubagentDrift[];
}

// ---------------------------------------------------------------------------
// loadSdk — lazy dynamic import path for production.
//
// The real package may not be present (optional peer dep), in which case
// the import throws. The caller wraps the throw into the standard
// `err({ kind: 'runtime' })` shape so the evaluator handles it like any
// other primitive failure.
// ---------------------------------------------------------------------------

async function loadSdk(): Promise<SubagentSdk> {
  // Variable-string import dodges TS module-resolution at compile time —
  // the SDK is an OPTIONAL peer dep, so it may not be present on disk in
  // dev (or in users' installs that don't opt into subagent spawning).
  // The string is identical at runtime; TS just doesn't try to resolve
  // the module specifier statically.
  const moduleName = '@anthropic-ai/claude-agent-sdk';
  const mod = (await import(/* @vite-ignore */ moduleName)) as unknown;
  return mod as SubagentSdk;
}

// ---------------------------------------------------------------------------
// generateSubagentId — opaque per-spawn id used in drift provenance.
//
// Not crypto-strong: this is a debugging / audit-trail key, not a security
// token. `Math.random().toString(36).slice(2, 10)` matches the same pattern
// used elsewhere (drift_catalog.test.ts seeds temp dirs the same way).
// ---------------------------------------------------------------------------

function generateSubagentId(): string {
  return `subagent-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// RegisterOptions — test seams (see file header).
//
// `sdk`               — inject a stub SDK to bypass the lazy dynamic import.
// `subagentIdFactory` — override the per-spawn id generator. Tests that
//                       assert provenance fields use this to pin a known
//                       id; production never passes it.
// ---------------------------------------------------------------------------

export interface RegisterSubagentOptions {
  sdk?: SubagentSdk;
  subagentIdFactory?: () => string;
}

// ---------------------------------------------------------------------------
// registerSubagentFunction — register `spawn_subagent` on a registry.
//
// `opts.sdk` overrides the lazy-import path (test-only — production never
// passes it). The function captures the option at registration time, so a
// later `opts.sdk` change has no effect on already-registered primitives.
// ---------------------------------------------------------------------------

export function registerSubagentFunction(
  registry: FunctionRegistry,
  opts: RegisterSubagentOptions = {},
): void {
  registry.register({
    name: 'spawn_subagent',
    argSchema: SpawnSubagentArgs,
    execute: async ({ model, prompt, context }, ctx) => {
      let sdk: SubagentSdk;
      try {
        sdk = opts.sdk ?? (await loadSdk());
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `spawn_subagent: failed to load SDK: ${String(e)}`,
          cause: e,
        });
      }

      let result: SubagentSdkRunResult;
      try {
        result = await sdk.runAgent({
          model,
          prompt,
          context: context ?? {},
        });
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `spawn_subagent: SDK run failed: ${String(e)}`,
          cause: e,
        });
      }

      // Task 6.4 — drift roll-up to the parent's session-level catalog.
      // `ctx.sessionId` is the PARENT's session (the primitive runs inside
      // the parent's evaluation), so the write target is the parent catalog
      // by construction. The subagent's own pack catalog is written by the
      // SDK-side evaluator during its run — we do NOT double-write here.
      const drifts = result.drifts ?? [];
      const subagentId = (opts.subagentIdFactory ?? generateSubagentId)();
      const professionPack = context?.profession ?? '<unspecified>';
      try {
        await recordSubagentDrifts(ctx.sessionId, subagentId, professionPack, drifts);
      } catch (e) {
        return err({
          kind: 'runtime',
          message: `spawn_subagent: drift roll-up failed: ${String(e)}`,
          cause: e,
        });
      }

      return ok<SpawnSubagentResult>({
        stdout: result.text,
        drifts,
      });
    },
  });
}

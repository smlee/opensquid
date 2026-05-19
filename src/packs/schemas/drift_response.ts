/**
 * Zod schema for `drift_response.yaml` — the pack's drift-response policy.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Drift response policies"
 * + memory `project_opensquid_drift_response_is_codex_declared`.
 *
 * When a rule emits a verdict, the runtime needs to decide WHAT TO DO about it
 * — and that "what to do" is pack-declared policy, not a hardcoded mechanism.
 * Six possible policies; Phase 1 ships the first four (`block_tool`, `warn`,
 * `full_stop_and_redo`, `notify_and_pause`); `auto_correct` + `escalate` are
 * accepted by this schema but deferred at the dispatcher layer (see
 * `runtime/types.ts` `DriftPolicy` notes — only the Phase-1 four are wired up).
 *
 * Schema accepts ALL SIX values intentionally — a pack author can declare
 * `auto_correct: true` in their YAML today; the runtime dispatcher returns
 * the fail-safe `notify_and_pause` until the auto-correct skill loop lands.
 * This keeps pack YAML forward-compatible.
 *
 * `.strict()` is applied to the top-level object — typos like `defualt` would
 * silently fall through to the default policy; for a safety-critical file,
 * we fail loudly instead.
 *
 * Default policy when the pack ships no `drift_response.yaml` at all is
 * `block_tool` per design doc §"Layered defaults" (the current opensquid
 * Phase 1 behavior — minimum-impact: refuse the one tool call).
 *
 * Imports from: zod only (self-contained per audit constraint).
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// DriftPolicyEnum — six policies per design doc §"Policy options".
//
// Phase-1-wired (in `runtime/drift_response.ts` dispatch table):
//   block_tool, warn, full_stop_and_redo, notify_and_pause
// Schema-accepted but dispatcher-deferred (fail-safe to notify_and_pause):
//   auto_correct, escalate
//
// Keeping all six in the schema means pack YAML stays forward-compatible
// without a schema bump when the dispatcher widens.
// ---------------------------------------------------------------------------

export const DriftPolicyEnum = z.enum([
  'block_tool',
  'warn',
  'full_stop_and_redo',
  'notify_and_pause',
  'auto_correct',
  'escalate',
]);
export type DriftPolicyEnum = z.infer<typeof DriftPolicyEnum>;

// ---------------------------------------------------------------------------
// DriftResponseConfig — top-level shape of `drift_response.yaml`.
//
// `default` — applied to any rule that doesn't declare its own policy.
// `per_rule` — rule_id → policy override. Lookup is direct: the dispatcher
// reads `per_rule[ruleId] ?? default` on every verdict.
// ---------------------------------------------------------------------------

export const DriftResponseConfig = z
  .object({
    default: DriftPolicyEnum.default('block_tool'),
    per_rule: z.record(z.string(), DriftPolicyEnum).default({}),
  })
  .strict();
export type DriftResponseConfig = z.infer<typeof DriftResponseConfig>;

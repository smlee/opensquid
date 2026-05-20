/**
 * Zod schema for `drift_response.yaml` — the pack's drift-response policy.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Drift response policies"
 * + memory `project_opensquid_drift_response_is_codex_declared`.
 *
 * When a rule emits a verdict, the runtime needs to decide WHAT TO DO about it
 * — and that "what to do" is pack-declared policy, not a hardcoded mechanism.
 * Six possible policies, all wired through the dispatcher:
 *   `block_tool`, `warn`, `full_stop_and_redo`, `notify_and_pause`
 *   `auto_correct` (AUTO.4 — invokes a corrective sub-skill)
 *   `escalate`     (AUTO.4 — bumps severity to 'critical' + reroutes)
 *
 * `.strict()` is applied to the top-level object — typos like `defualt` would
 * silently fall through to the default policy; for a safety-critical file,
 * we fail loudly instead.
 *
 * `corrective_skills:` is a per-rule map (rule_id → corrective skill name)
 * consulted by the `auto_correct` policy at dispatch time. Absent entries
 * are detected at the AUTO.4 runtime layer and degraded to `notify_pause`
 * with a clear reason (no silent fail-open).
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
// All six are wired through the dispatcher in `runtime/drift_response.ts`
// (AUTO.4 finished the two previously-deferred policies). The runtime layers
// `auto_correct.ts` + `escalate.ts` interpret the action descriptors that
// the dispatcher emits.
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
// `corrective_skills` — rule_id → corrective skill name, consulted ONLY by
// the `auto_correct` policy. Decoupled from `per_rule` so an author can
// declare a corrective skill for a rule that currently uses `block_tool`
// (and flip to `auto_correct` later without re-wiring the map).
// ---------------------------------------------------------------------------

export const DriftResponseConfig = z
  .object({
    default: DriftPolicyEnum.default('block_tool'),
    per_rule: z.record(z.string(), DriftPolicyEnum).default({}),
    corrective_skills: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();
export type DriftResponseConfig = z.infer<typeof DriftResponseConfig>;

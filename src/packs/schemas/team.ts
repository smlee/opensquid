/**
 * Zod schema for `team.yaml` — Mode A team-pack manifest extension.
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Team modes" Mode A
 * + memory `project_opensquid_team_modes` (Mode A = one agent + Agent-tool
 * subagents for profession-instantiation; Mode B = multi-tenant, future).
 *
 * A team pack declares a list of subagent ROLES that the parent agent can
 * spawn via the `spawn_subagent` primitive (Task 6.2). Each role binds:
 *
 *   - `name`           — role identifier the parent references when spawning.
 *   - `pack`           — the profession pack the subagent loads (e.g.
 *                        `profession/code-reviewer`). The subagent's universal
 *                        pinned skills come from its OWN pack set, NOT the
 *                        parent's — see context inheritance (Task 6.3).
 *   - `model_alias`    — model-neutral task-purpose label (e.g. `reasoning`,
 *                        `fast_classifier`). Resolved against the user's
 *                        `models.yaml` at spawn time, never hardcoded to a
 *                        vendor model name.
 *   - `handoff_signal` — optional sentinel string the subagent emits to
 *                        signal completion (e.g. `'REVIEW_COMPLETE'`). Parent
 *                        scans subagent stdout for this signal.
 *   - `instructions`   — optional role-specific system prompt addendum.
 *
 * Model neutrality (per `project_opensquid_model_neutral_subagent_primitive`):
 * `model_alias` is a USER-SUPPLIED alias name, never a concrete vendor model
 * id. The schema validates only that it's a non-empty string — the alias
 * resolution happens at spawn time against the active models config.
 *
 * `.min(1)` on `roles` enforces "a team has at least one role". An empty
 * team pack is a configuration error (no subagents to spawn means the
 * Mode-A orchestration this file exists to support is silently broken).
 *
 * Imports from: zod only (self-contained per audit constraint).
 * Imported by: src/packs/schemas/index.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// SubagentRole — one declarative role inside a team pack.
//
// `pack` + `model_alias` are required strings (min 1) because spawn-time
// resolution against the pack registry + models config has no sensible
// fallback. `handoff_signal` + `instructions` stay optional — most roles
// terminate on natural completion and inherit the profession pack's prompt.
// ---------------------------------------------------------------------------

export const SubagentRole = z.object({
  name: z.string().min(1),
  pack: z.string().min(1),
  model_alias: z.string().min(1),
  handoff_signal: z.string().optional(),
  instructions: z.string().optional(),
});
export type SubagentRole = z.infer<typeof SubagentRole>;

// ---------------------------------------------------------------------------
// Team — the team pack's role list.
//
// `name` identifies the team (e.g. `review-team`, `incident-response-team`).
// `roles.min(1)` blocks zero-role teams at load time.
// ---------------------------------------------------------------------------

export const Team = z.object({
  name: z.string().min(1),
  roles: z.array(SubagentRole).min(1),
});
export type Team = z.infer<typeof Team>;

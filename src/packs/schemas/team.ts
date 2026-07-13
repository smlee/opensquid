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
 *   - `model_alias`    — optional model-neutral task-purpose override (e.g. `reasoning`).
 *                        When absent, the executor inherits its parent model.
 *                        When present, it resolves against the user's `models.yaml`.
 *   - `handoff_signal` — optional sentinel string the subagent emits to
 *                        signal completion (e.g. `'REVIEW_COMPLETE'`). Parent
 *                        scans subagent stdout for this signal.
 *   - `instructions`   — optional role-specific system prompt addendum.
 *
 * Model neutrality (per `project_opensquid_model_neutral_subagent_primitive`):
 * `model_alias`, when present, is a USER-SUPPLIED alias name rather than a concrete vendor model id.
 * Alias resolution happens at spawn time against the active models config.
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
// `pack` is required. `model_alias` is an explicit optional user-configured override; when absent, a harness
// executor inherits the parent session's resolved provider/model. `handoff_signal` + `instructions` stay optional.
// ---------------------------------------------------------------------------

export const SubagentRole = z.object({
  name: z.string().min(1),
  pack: z.string().min(1),
  model_alias: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).min(1).optional(),
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

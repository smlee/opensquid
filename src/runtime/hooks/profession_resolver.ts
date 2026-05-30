/**
 * MM.2 — Pure-function resolver for `next_action.profession` directives.
 *
 * Given a directive whose `next_action.profession` names a pack + the loaded
 * pack registry + a pre-staged `teamsByPack` map, validates that the pack
 * exists, is profession-usage, and has at least one role defined in its
 * team.yaml. Returns a tagged result.
 *
 * **opensquid never invokes `spawn_subagent` itself** per
 * [[project_opensquid_no_agent_loop]] — this resolver only validates the
 * directive is well-formed before the dispatcher aggregates it onto the
 * UserPromptSubmit envelope. The AGENT then calls `spawn_subagent` on the
 * profession pack named by the directive.
 *
 * Fail-open in the SAFE direction: an invalid profession → directive DROPPED
 * (not emitted to the agent) + a warning is logged at the caller. Emitting a
 * directive for a non-existent / misconfigured profession would mislead the
 * agent.
 *
 * Imports: types only (zero I/O). Imported by: `src/runtime/hooks/dispatch.ts`
 * + tests.
 */

import type { Team } from '../../packs/schemas/team.js';
import type { NextAction, Pack } from '../types.js';

export type ProfessionResolutionError =
  | { code: 'unknown-pack'; packName: string }
  | { code: 'wrong-usage'; packName: string; actualUsage: string }
  | { code: 'missing-team'; packName: string }
  | { code: 'no-roles'; packName: string }
  | { code: 'role-not-found'; packName: string; requestedRole: string };

export type ProfessionResolution =
  | { ok: true; pack: Pack; team: Team; role: Team['roles'][number] }
  | { ok: false; reason: ProfessionResolutionError };

/**
 * Validate a profession directive against the loaded pack registry +
 * pre-staged team map. Pure function — no I/O.
 *
 * Phase 2 leaf-node-profession discipline: roles[0] is returned. Phase 4+
 * multi-role lookup will accept a `role:` name in `nextAction.args`.
 */
export function resolveProfessionDirective(
  nextAction: NextAction,
  packs: readonly Pack[],
  teamsByPack: ReadonlyMap<string, Team>,
): ProfessionResolution {
  if (nextAction.profession === undefined) {
    return { ok: false, reason: { code: 'unknown-pack', packName: '<undefined>' } };
  }
  const packName = nextAction.profession;
  const pack = packs.find((p) => p.name === packName);
  if (pack === undefined) {
    return { ok: false, reason: { code: 'unknown-pack', packName } };
  }
  const usage = pack.usage ?? 'active';
  if (usage !== 'profession' && usage !== 'both') {
    return {
      ok: false,
      reason: { code: 'wrong-usage', packName, actualUsage: usage },
    };
  }
  const team = teamsByPack.get(packName);
  if (team === undefined) {
    return { ok: false, reason: { code: 'missing-team', packName } };
  }
  if (team.roles.length === 0) {
    return { ok: false, reason: { code: 'no-roles', packName } };
  }
  const requestedRole =
    typeof nextAction.args?.role === 'string' ? nextAction.args.role : undefined;
  if (requestedRole !== undefined) {
    const match = team.roles.find((r) => r.name === requestedRole);
    if (match === undefined) {
      return {
        ok: false,
        reason: { code: 'role-not-found', packName, requestedRole },
      };
    }
    return { ok: true, pack, team, role: match };
  }
  // Phase 2: leaf-node profession — first role wins.
  const role = team.roles[0]!;
  return { ok: true, pack, team, role };
}

/**
 * Render a `ProfessionResolutionError` to a human-scannable string. Used by
 * the dispatcher to log to stderr + violations.log.
 */
export function formatProfessionError(err: ProfessionResolutionError): string {
  switch (err.code) {
    case 'unknown-pack':
      return `directive references profession "${err.packName}" but no pack with that name is loaded`;
    case 'wrong-usage':
      return `directive references profession "${err.packName}" but its usage is "${err.actualUsage}" — must be "profession" or "both"`;
    case 'missing-team':
      return `directive references profession "${err.packName}" but the pack has no loadable team.yaml`;
    case 'no-roles':
      return `directive references profession "${err.packName}" but its team.yaml declares zero roles`;
    case 'role-not-found':
      return `directive references profession "${err.packName}" + role "${err.requestedRole}" — role not found in team.yaml`;
  }
}

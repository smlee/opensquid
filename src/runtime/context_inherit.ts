/**
 * `inheritContext` — Mode A context-inheritance filter for subagent spawns.
 *
 * Per `docs/opensquid-real-design.md` §"Team modes" Mode A: a subagent does
 * NOT inherit the parent's full pack stack. It receives a narrowed view —
 * just enough to operate inside the same project as the parent, plus the
 * profession layer the parent designated for this role.
 *
 * Filter policy (matches the design doc constraint "NOT the parent's full
 * stack"):
 *
 *   - INCLUDE: every pack with `scope === 'project'`. Project scope binds
 *     to the repo / tenant the parent is operating in; the subagent must
 *     see the same project context to operate coherently. There is no
 *     leakage risk: project scope IS the shared workspace by definition.
 *
 *   - INCLUDE: specialty + domain packs whose `name` matches the supplied
 *     `profession`. This is how the parent declares "spawn a code-reviewer"
 *     — the team role's `pack` field names the profession pack, and this
 *     filter only lets THAT pack through (not every domain/specialty pack
 *     the parent happened to load).
 *
 *   - EXCLUDE: `universal` packs. The subagent's universal pinned skills
 *     come from its OWN pack set (loaded via the profession pack's
 *     `requires` chain), NOT the parent's. Otherwise a parent loading a
 *     personal-rules universal pack would silently inject those rules into
 *     every subagent it spawns, breaking the "fresh-eyes" property that
 *     justifies Mode A in the first place.
 *
 *   - EXCLUDE: `workflow` packs. Workflows are parent-task-specific
 *     (e.g. "ship verified work" tracks the parent's check sequence); a
 *     subagent operates on its own task within that workflow, not the
 *     workflow itself. Letting workflow packs through would conflate
 *     parent + subagent verification state.
 *
 *   - EXCLUDE: specialty + domain packs whose name doesn't match the
 *     profession. The parent may have many specialties loaded; the
 *     subagent gets exactly the one designated for its role.
 *
 * `profession` is OPTIONAL — a subagent spawn that doesn't designate a
 * profession just gets the project packs (parent and subagent share the
 * same workspace context but no specialty inheritance). Returning project
 * packs only in that case is the conservative default.
 *
 * Memory layer (relevant context):
 *   - `project_opensquid_team_modes` — Mode A constraint.
 *   - `project_opensquid_reduced_context_first_principle` — minimize what
 *     reaches the subagent's context window.
 *
 * Imports from: ./types.js (Pack type).
 * Imported by: src/runtime/index.ts.
 */

import type { Pack } from './types.js';

/**
 * Filter a parent's pack list down to the subset a subagent should see.
 *
 * @param parentPacks   The parent agent's currently-active pack stack.
 * @param profession    Optional name of the profession pack designated for
 *                      this subagent role (matches `Pack.name` for one of
 *                      the parent's specialty / domain packs).
 * @returns             The narrowed pack list: project packs + at most one
 *                      matching specialty-or-domain pack.
 */
export function inheritContext(parentPacks: Pack[], profession: string | undefined): Pack[] {
  return parentPacks.filter((p) => {
    if (p.scope === 'project') return true;
    if (
      profession !== undefined &&
      profession.length > 0 &&
      (p.scope === 'specialty' || p.scope === 'domain') &&
      p.name === profession
    ) {
      return true;
    }
    return false;
  });
}

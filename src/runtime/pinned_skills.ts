/**
 * Pinned-skill semantics for universal-scope packs (Phase 3 Task 3.5).
 *
 * Purpose: partition every skill across the loaded pack set into two
 * disjoint groups — `pinned` (always-on for this user) and `dynamic`
 * (subject to when_to_load + unloads_when evaluation). The dispatcher
 * loads pinned skills at session start and keeps them resident until
 * session end; dynamic skills flow through the prefilter + router +
 * unload tick pipeline.
 *
 * The rule (per design doc §"Phases 2–7 summary" Phase 3):
 *
 *     Universal-scope pack + load: preload skill  →  PINNED
 *     Everything else                              →  DYNAMIC
 *
 * Pinned semantics encode "this is foundational hygiene for THIS user"
 * (see `project_opensquid_personal_rules_are_user_pack` — Sangmin's
 * 17 anti-drift rules are exactly this kind of pack). Universal scope
 * is the user-pack tier; preload says "load immediately, do not wait
 * for a matcher". The intersection is the pin.
 *
 * Workflow / domain / specialty / project packs CANNOT pin even if
 * they're authored with `load: preload` — preload at those scopes
 * means "load when the scope activates" (the dispatcher decides when),
 * not "load forever". A workflow's preload skills are still dynamic
 * from the partition's point of view; they just have an empty
 * `when_to_load` and so activate at workflow-activation time.
 *
 * Contradiction detection: a universal-scope pack that declares
 * `unloads_when` on a skill that ALSO has `load: preload` is
 * pathological — the partition pins the skill (preload + universal
 * wins), but the pack author also asked it to unload. We emit a
 * stderr warning so the user sees the inconsistency. The pin takes
 * precedence; the dispatcher (Phase 4 wiring) MUST skip the unload
 * evaluator for pinned skills.
 *
 * The function is pure (no I/O beyond stderr warnings) so it's safe
 * to call from any layer that has the resolved pack set.
 *
 * Imports from: ./types.js (Pack + Skill types).
 * Imported by: src/runtime/index.ts (re-exported as `partitionSkills`
 *   + `SkillSet`) and the dispatcher's session-bootstrap path once
 *   Phase 3 wiring lands.
 */

import type { Pack, Skill } from './types.js';

// ---------------------------------------------------------------------------
// SkillSet — the partition output.
//
// Each entry carries the parent `Pack` reference so downstream code (the
// dispatcher, the event router) can resolve scope + drift_response policy
// without a second lookup. The pack reference is the same object that was
// passed in — no deep clone — so pinned & dynamic entries can be compared
// by referential equality if needed.
// ---------------------------------------------------------------------------

export interface SkillSet {
  pinned: { pack: Pack; skill: Skill }[];
  dynamic: { pack: Pack; skill: Skill }[];
}

/**
 * Partition every skill across `packs` into pinned (universal+preload) and
 * dynamic (everything else). Pure function — the only side effect is a
 * stderr warning when a universal-pack skill has BOTH `load: preload` and
 * a non-empty `unloads_when` (contradictory).
 */
export function partitionSkills(packs: Pack[]): SkillSet {
  const pinned: SkillSet['pinned'] = [];
  const dynamic: SkillSet['dynamic'] = [];

  for (const pack of packs) {
    for (const skill of pack.skills) {
      const isPinned = pack.scope === 'universal' && skill.load === 'preload';

      if (isPinned) {
        if (skill.unloads_when.length > 0) {
          // Author asked for both pin and unload — keep the pin, warn loudly.
          // stderr (not stdout) so this doesn't pollute MCP stdout JSON-RPC
          // when the runtime is hosted under a stdio MCP server.
          process.stderr.write(
            `[opensquid] warning: universal-scope pack "${pack.name}" declares ` +
              `unloads_when on pinned skill "${skill.name}" — unloads_when will ` +
              `be ignored (pinned skills are resident for the whole session).\n`,
          );
        }
        pinned.push({ pack, skill });
      } else {
        dynamic.push({ pack, skill });
      }
    }
  }

  return { pinned, dynamic };
}

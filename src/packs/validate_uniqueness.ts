/**
 * Skill-name uniqueness validation (Task 2.5) — collisions across loaded
 * packs are surfaced (not auto-resolved) per design doc §"Pack validation
 * checks" + §"Conflict resolution policy". The setup UI / load orchestrator
 * presents the issue and lets the user rename or remove (UI.8).
 *
 * Imports from: runtime/types.ts (Pack).
 * Imported by: packs/ index re-export; load orchestrator (Phase 3+).
 */

import type { Pack } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// UniquenessIssue — one entry per skill name claimed by more than one pack.
//
// `packs` lists every pack declaring the skill, in iteration order. A pack
// appears twice when it declares the same skill name internally (rare but
// possible — surface, don't merge).
// ---------------------------------------------------------------------------

export interface UniquenessIssue {
  skill: string;
  packs: string[];
}

// ---------------------------------------------------------------------------
// validateUniqueSkillNames — aggregate skill → packs[] map; collisions → issues.
//
// Runs at load-orchestrator time (after every pack has been loaded). Never
// short-circuits and never resolves the collision; all issues returned so the
// user fixes them in one pass.
// ---------------------------------------------------------------------------

export function validateUniqueSkillNames(packs: Pack[]): UniquenessIssue[] {
  const byName = new Map<string, string[]>();
  for (const p of packs) {
    for (const s of p.skills) {
      const list = byName.get(s.name) ?? [];
      list.push(p.name);
      byName.set(s.name, list);
    }
  }
  const issues: UniquenessIssue[] = [];
  for (const [skill, ownerPacks] of byName) {
    if (ownerPacks.length > 1) issues.push({ skill, packs: ownerPacks });
  }
  return issues;
}

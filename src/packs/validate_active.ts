/**
 * Active-pack integrity validation (T-wire-pack-validators PV.1) — the session-start surface that
 * activates the previously-orphaned `validatePackFunctions` + `validateUniqueSkillNames` validators.
 *
 * Wraps both validators over the live active packs into human-readable problem strings. FAIL-OPEN:
 * a health check must NEVER break a session, so any internal error degrades to `[]` (mirrors
 * `flowEnforcementProblems`). The registry NAME set comes from `buildValidationRegistry` (no-op
 * backends, no I/O) so it stays in sync with the real runtime registry automatically.
 *
 * Imports from: ../runtime/bootstrap.js (buildValidationRegistry, loadActivePacks),
 *   ./validate_functions.js, ./validate_uniqueness.js.
 * Imported by: src/functions/check_flow_health.ts (the session_start inject); (future) cli/doctor.
 */

import { buildValidationRegistry, loadActivePacks } from '../runtime/bootstrap.js';

import { validatePackFunctions } from './validate_functions.js';
import { validateUniqueSkillNames } from './validate_uniqueness.js';

/**
 * Problem strings for the active packs: unknown `call:` references (with a Levenshtein suggestion)
 * + cross-pack skill-name collisions. Empty ⇒ the active packs are integrity-clean. Never throws.
 */
export async function validateActivePacks(sessionId: string): Promise<string[]> {
  try {
    const [registry, packs] = await Promise.all([
      buildValidationRegistry(),
      loadActivePacks(sessionId),
    ]);
    const problems: string[] = [];
    for (const pack of packs) {
      for (const i of validatePackFunctions(pack, registry)) {
        problems.push(
          `pack "${i.pack}" → skill "${i.skill}" → rule "${i.ruleId}" step ${String(i.step)}: ` +
            `unknown primitive "${i.missing}"` +
            (i.suggestion !== undefined ? ` (did you mean "${i.suggestion}"?)` : '') +
            ' — that rule will SILENTLY not enforce',
        );
      }
    }
    for (const u of validateUniqueSkillNames(packs)) {
      problems.push(`skill name "${u.skill}" is claimed by multiple packs: ${u.packs.join(', ')}`);
    }
    return problems;
  } catch {
    // Fail-OPEN: a session-start health check must never break the session.
    return [];
  }
}

/**
 * `Skill.requires:` AND-semantic precondition evaluator (T-ASC, ASC.2).
 *
 * Slots into the dispatcher between `matchesEvent` (per-skill activation
 * filter) and the rule walk. AND-semantics: every entry must hold; empty
 * array trivially holds (back-compat with every existing skill).
 *
 * Three precondition kinds (discriminated-union by `kind`):
 *   automation_mode_on  — stat `<home>/sessions/<id>/automation.flag`
 *   active_task_present — stat `<home>/sessions/<id>/active-task.json`
 *   chain_stage:<stage> — readChainStage(sessionId) === <stage>
 *
 * Fail-open in the engaged direction (T-ASC L5 / L6 lock): any stat error
 * OTHER than ENOENT (EACCES, EPERM, EIO, EROFS, …) ⇒ assume engaged, return
 * true. Wrong direction would silently disable every personal-pack skill on
 * a `chmod 000 ~/.opensquid` event. The probe's contract: TRUE (= present /
 * engaged) is the default for uncertainty.
 *
 * Per-fire cache (L6): the dispatcher constructs ONE `RequiresCache` per
 * `dispatchEvent` call and threads it to every `skillRequiresHold` invocation
 * across all loaded skills. N skills sharing `automation_mode_on` stat the
 * flag ONCE per fire. The cache is per-CALL, NEVER module-level — hook bins
 * are short-lived processes; long-lived state would cross process boundaries
 * meaninglessly.
 *
 * Imports from: node:fs/promises, zod, ./automation_state.js, ./chain_state.js,
 *   ./paths.js.
 * Imported by: src/packs/schemas/skill.ts (the Skill schema's `requires:`
 *   field type), src/runtime/types.ts (the runtime type mirror),
 *   src/runtime/hooks/dispatch.ts (the dispatcher integration point).
 */

import { stat } from 'node:fs/promises';

import { z } from 'zod';

import { automationFlagPath } from './automation_state.js';
import { CHAIN_STAGES, readChainStage, type ChainStage } from './chain_state.js';
import { activeTaskFile } from './paths.js';

/**
 * SkillRequires variant. Discriminated by `kind`. Adding a new precondition
 * kind means adding a variant here AND a branch in `skillRequiresHold`'s
 * switch AND a getter on `RequiresCache`. Exhaustiveness is enforced by
 * TypeScript narrowing in the switch.
 */
export const SkillRequires = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('automation_mode_on') }).strict(),
  z.object({ kind: z.literal('active_task_present') }).strict(),
  z
    .object({
      kind: z.literal('chain_stage'),
      stage: z.enum(CHAIN_STAGES),
    })
    .strict(),
]);
export type SkillRequires = z.infer<typeof SkillRequires>;

/**
 * Per-fire cache. The dispatcher constructs ONE instance per `dispatchEvent`
 * call. Three maps keyed by sessionId because each precondition has a single
 * relevant input (the session). `chain_stage` stores the RESOLVED stage once;
 * subsequent `chain_stage` preconditions for different stages compare against
 * the cached stage rather than re-reading the file.
 *
 * Strictly avoid making this a module-level cache: hook bins are short-lived
 * processes (one per host event) and per-call caching is the right scope.
 */
export class RequiresCache {
  private readonly automation = new Map<string, boolean>();
  private readonly activeTask = new Map<string, boolean>();
  private readonly chainStage = new Map<string, ChainStage>();

  async automationModeOn(sessionId: string): Promise<boolean> {
    const cached = this.automation.get(sessionId);
    if (cached !== undefined) return cached;
    const present = await probePresent(automationFlagPath(sessionId));
    this.automation.set(sessionId, present);
    return present;
  }

  async activeTaskPresent(sessionId: string): Promise<boolean> {
    const cached = this.activeTask.get(sessionId);
    if (cached !== undefined) return cached;
    const present = await probePresent(activeTaskFile(sessionId));
    this.activeTask.set(sessionId, present);
    return present;
  }

  async chainStageOf(sessionId: string): Promise<ChainStage> {
    const cached = this.chainStage.get(sessionId);
    if (cached !== undefined) return cached;
    const stage = await readChainStage(sessionId);
    this.chainStage.set(sessionId, stage);
    return stage;
  }
}

/**
 * AND-evaluate every precondition. Empty array → trivially true (back-compat
 * with every Phase 1+ pack). Short-circuits on first false: skills that
 * declare multiple preconditions don't pay for later checks once one fails.
 *
 * The exhaustive switch keeps TypeScript narrowing — adding a new variant
 * to `SkillRequires` without adding a case here is a typecheck error.
 */
export async function skillRequiresHold(
  preconds: readonly SkillRequires[],
  sessionId: string,
  cache: RequiresCache,
): Promise<boolean> {
  for (const p of preconds) {
    switch (p.kind) {
      case 'automation_mode_on':
        if (!(await cache.automationModeOn(sessionId))) return false;
        break;
      case 'active_task_present':
        if (!(await cache.activeTaskPresent(sessionId))) return false;
        break;
      case 'chain_stage':
        if ((await cache.chainStageOf(sessionId)) !== p.stage) return false;
        break;
      default: {
        // Exhaustiveness check — TS narrows `p` to `never` here when every
        // variant has a case above. Adding a new SkillRequires variant
        // without a case lights up at compile time.
        const _exhaustive: never = p;
        return _exhaustive;
      }
    }
  }
  return true;
}

/**
 * Stat probe with fail-open semantics in the engaged direction.
 *   - clean ENOENT → false (absent: the gate may treat as "not engaged")
 *   - any other error (EACCES/EPERM/EIO/EROFS/…) → true (assume engaged;
 *     never silently swallow a gate over a permissions/IO blip inside a
 *     short-lived hook bin)
 *   - successful stat → true (present)
 */
async function probePresent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

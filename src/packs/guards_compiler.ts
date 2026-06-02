/**
 * T-PACK-FSM-STANDARDIZATION slice B — `guards` -> synthetic skill compilation.
 *
 * A Guard is the GENERAL form of the detect→verdict skeleton that ~23/24 skills
 * hand-respell (e.g. `default-discipline/skills/git/skill.yaml`'s two rules).
 * Each guard compiles into one `TrackCheckRule` whose process is `[detect?,
 * verdict]`, grouped under the synthetic skill `<pack>/guards`:
 *
 *   - `detect` (optional) — a generic primitive call bound via `as`. Omitted
 *     for a check-only guard (the `verify_gate` shape).
 *   - `verdict` — fired conditionally via `step.if = guard.when`, the same
 *     `if:` expression engine + 5-fn allow-list the hand-written rules use.
 *
 * This is the reusable gate TEMPLATE: the skeleton lives HERE (in the
 * compiler), so authors declare only the shape's parameters. The output is the
 * EXACT `ProcessStep[]` an author would hand-write, so the runtime interpreter
 * is unchanged (proven byte-identical in `guards_compiler.test.ts`).
 *
 * `verify_gates_compiler.ts` is the detect-less special case of this; the two
 * stay separate while `verify_gates` keeps its own schema (a later slice may
 * fold verify_gates into guards once the template surface settles).
 *
 * Pure: no I/O. Caller (`loader.ts`) appends the synthetic skill into
 * `pack.skills` alongside hand-authored skills and the `<pack>/verify` skill.
 *
 * Audit trail: each compiled rule's `id` is `guard:<name>` so a drift-catalog
 * grep can attribute the verdict to its source guard.
 */
import type { SkillType, RuleType, ProcessStepType } from './schemas/index.js';
import { parseExpression } from '../runtime/evaluator/expression/index.js';
import type { Guard } from './schemas/manifest.js';
import { DEFAULT_TRIGGERS, type Trigger } from '../runtime/event.js';

export interface GuardsCompileSuccess {
  ok: true;
  skill: SkillType;
}
export interface GuardsCompileFailure {
  ok: false;
  errors: readonly { guardName: string; message: string }[];
}
export type GuardsCompileResult = GuardsCompileSuccess | GuardsCompileFailure;

/**
 * Compile `guards` into a single synthetic skill `<pack>/guards`. When `guards`
 * is empty the result is `{ok: true, skill}` with a zero-rule skill — callers
 * SHOULD filter out empty-rule skills before appending (matches
 * `compileVerifyGates`). A `when` expression that fails to parse is collected
 * (with its guard name) and surfaced as `{ok: false, errors}` — no silent skip.
 */
export function compileGuards(packName: string, guards: readonly Guard[]): GuardsCompileResult {
  const errors: { guardName: string; message: string }[] = [];
  const rules: RuleType[] = [];

  for (const guard of guards) {
    try {
      parseExpression(guard.when);
    } catch (e) {
      errors.push({
        guardName: guard.name,
        message: `when failed to parse: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const process: ProcessStepType[] = [];
    if (guard.detect !== undefined) {
      process.push({
        call: guard.detect.call,
        ...(guard.detect.args !== undefined ? { args: guard.detect.args } : {}),
        as: guard.as,
      });
    }
    process.push({
      call: 'verdict',
      if: guard.when,
      args: { level: guard.level, message: guard.message },
    });

    rules.push({ id: `guard:${guard.name}`, kind: 'track_check', requires: [], process });
  }

  if (errors.length > 0) return { ok: false, errors };

  // Triggers: one per guard's event kind, deduped (matches compileVerifyGates).
  const kinds = new Set<Trigger['kind']>(guards.map((g) => g.on));
  const triggers: Trigger[] =
    guards.length === 0 ? [...DEFAULT_TRIGGERS] : [...kinds].map((kind) => ({ kind }));

  const skill: SkillType = {
    name: `${packName}/guards`,
    load: 'lazy',
    when_to_load: [],
    requires: [],
    unloads_when: [],
    triggers,
    rules,
    tools: [],
  };
  return { ok: true, skill };
}

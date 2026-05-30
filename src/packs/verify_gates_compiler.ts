/**
 * DOG.3 — verify_gates -> synthetic skill compilation.
 *
 * Each `VerifyGate` declared in a pack's manifest compiles into one
 * `TrackCheckRule` whose process is a single `verdict` primitive step
 * conditionally fired via `step.if = gate.check`. The compiled rules are
 * grouped under a synthetic skill named `<pack>/verify` with triggers
 * derived from each gate's `when` block.
 *
 * Why this shape:
 *   - `step.if` is evaluated by the existing process evaluator (see
 *     `src/runtime/evaluator.ts` — `evalCondition`) using the same 5-fn
 *     allow-list (`len`/`contains`/`startsWith`/`endsWith`/`match`).
 *   - The `verdict` primitive is the canonical way to emit a verdict from
 *     a rule (matches `packs/builtin/default-discipline/skills/git/skill.yaml`).
 *   - Load-time pre-parse of every `check` string via `parseExpression`
 *     fails loudly with the offending gate's name when grammar is wrong
 *     (no silent skipping).
 *
 * Pure: no I/O. Caller (loader.ts) appends the synthetic skill into
 * `pack.skills` alongside hand-authored skills.
 *
 * Audit trail: each compiled rule's `id` is `gate:<gate-name>` so a
 * drift-catalog grep can attribute the verdict to its source gate.
 */
import type { SkillType, RuleType, ProcessStepType } from './schemas/index.js';
import { parseExpression } from '../runtime/evaluator/expression/index.js';
import type { VerifyGate } from './schemas/manifest.js';
import { DEFAULT_TRIGGERS, type Trigger } from '../runtime/event.js';

export interface CompileSuccess {
  ok: true;
  skill: SkillType;
}
export interface CompileFailure {
  ok: false;
  errors: readonly { gateName: string; message: string }[];
}
export type CompileResult = CompileSuccess | CompileFailure;

/**
 * Compile `gates` into a single synthetic skill. When `gates` is empty
 * the result is `{ok: true, skill}` with a default-trigger skill that
 * carries zero rules — callers SHOULD filter out empty-rule skills before
 * appending to the pack to keep dispatcher noise low.
 */
export function compileVerifyGates(packName: string, gates: readonly VerifyGate[]): CompileResult {
  const errors: { gateName: string; message: string }[] = [];
  const rules: RuleType[] = [];

  for (const gate of gates) {
    try {
      parseExpression(gate.check);
    } catch (e) {
      errors.push({
        gateName: gate.name,
        message: `check failed to parse: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    const step: ProcessStepType = {
      call: 'verdict',
      if: gate.check,
      args: {
        level: gate.on_fail.level,
        message: gate.on_fail.message,
      },
    };
    rules.push({
      id: `gate:${gate.name}`,
      kind: 'track_check',
      requires: [],
      process: [step],
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  // Triggers: one per gate's event_kind, deduped. Tool-name filtering, if
  // wanted, belongs INSIDE the `check` expression (e.g. `match(tool,
  // '^Bash$') && contains(tool_args.command, 'rm -rf')`) — the `tool_call`
  // Trigger variant in event.ts intentionally carries no per-trigger
  // tool_match field (matches existing skill grammar).
  const kinds = new Set<Trigger['kind']>(gates.map((g) => g.when.event_kind));
  const triggers: Trigger[] =
    gates.length === 0 ? [...DEFAULT_TRIGGERS] : [...kinds].map((kind) => ({ kind }));

  const skill: SkillType = {
    name: `${packName}/verify`,
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

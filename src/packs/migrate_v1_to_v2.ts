/**
 * M.2 — migrate a v1 `Pack` (flat skills + rules + side-file fsm/foundation) to a v2 `PackV2`,
 * BY FORM and fail-loud. A v1 pack is exactly one of three forms:
 *
 *   behavior   → a lifecycle FSM (states + transitions + emits). The FSM is NOT derivable from the
 *                flat skills — it comes from the v1 `fsm.yaml` side-file, supplied as `table.fsm`.
 *   conformance→ always-active discipline rules. Each v1 rule RE-HOMES into the matching
 *                `ConformanceGate` kind, fields VERBATIM. The `process` array is passed through
 *                unchanged; `PackV2.parse` (the fail-loud validation below) re-validates it into a
 *                faithful structural copy — so a migrated `track_check` runs the SAME steps the v1
 *                evaluator walked (structural + behavioral identity, proven in the M.2 equivalence test).
 *   foundation → pure expertise: the v1 `foundation` block passes through; neither fsm nor gates.
 *
 * The migration RE-SHAPES the schema only — it adds NO evaluation logic. Each kind keeps its own
 * proven runtime: `track_check`→`evaluateProcess` (`evaluator.ts:153`), `destination_check`→the
 * scheduler + `check_destination`. The bug surface is the MAPPING, pinned by per-path equivalence.
 *
 * Spec: loop/docs/tasks/T-pack-migrate-v2.md §M.2.
 */
import type { Transition } from '../runtime/fsm.js';
import type { Pack, Rule, Skill } from '../runtime/types.js';
import { PackV2, type ConformanceGate, type StateV2 } from './schemas/pack_v2.js';

/** A conformance on_fail in the V2 action vocabulary (`warn|block|halt` — includes `warn`, unlike a
 *  behavior `GateState.on_fail` which is `block|halt`). */
export interface ConformanceFail {
  action: 'warn' | 'block' | 'halt';
  message: string;
}

/** The EXPLICIT per-pack migration plan — never inferred. `form` selects the shape; a behavior pack
 *  carries the FSM (from the v1 `fsm.yaml` side-file); a conformance pack carries the drift-policy →
 *  on_fail map (v1 `driftResponse.per_rule[id] ?? .default` → the 3-action conformance enum). */
export interface MigrationTable {
  form: 'behavior' | 'conformance' | 'foundation';
  fsm?: { initial: string; states: Record<string, StateV2>; transitions: Transition[] };
  onFail?: (ruleId: string) => ConformanceFail | undefined;
}

/** The event-name(s) a skill's rules react to — the v1 `triggers` block (kind list), re-homed as the
 *  gate `trigger`. `Skill.triggers` is `min(1)` (`types.ts:308`) so this is always non-empty. */
function triggerNames(skill: Skill): string[] {
  return skill.triggers.map((t) => t.kind);
}

/** Re-home ONE v1 rule into its matching `ConformanceGate` kind, fields VERBATIM. `process` is passed
 *  through unchanged (the caller's `PackV2.parse` re-validates it into a faithful copy). */
function ruleToGate(
  rule: Rule,
  triggers: string[],
  onFail?: MigrationTable['onFail'],
): ConformanceGate {
  const fail = onFail?.(rule.id);
  if (rule.kind === 'track_check') {
    if (triggers.length === 0) {
      throw new Error(`migrateV1: track_check '${rule.id}' has no trigger (empty skill triggers)`);
    }
    return {
      kind: 'track_check',
      trigger: triggers,
      process: rule.process, // VERBATIM — the v1 steps, re-validated by the caller's PackV2.parse
      ...(fail !== undefined ? { on_fail: fail } : {}),
    };
  }
  if (rule.kind === 'destination_check') {
    return {
      kind: 'destination_check',
      prompt_template: rule.prompt_template,
      every_n_tool_calls: rule.interval.every_n_tool_calls,
      model_alias: rule.model_alias,
      ...(fail !== undefined ? { on_fail: fail } : {}),
    };
  }
  // total: the v1 Rule union has exactly two kinds — an unmapped kind is a bug, never a silent drop.
  throw new Error(`migrateV1: unmapped rule kind '${(rule as { kind: string }).kind}'`);
}

/** Migrate a v1 `Pack` to a `PackV2` by FORM. Returns a parsed (validated, defaults-applied) PackV2 —
 *  so a malformed migration fails LOUD at the schema boundary (incl. the fsm-XOR-gates refine). */
export function migrateV1(v1: Pack, table: MigrationTable): PackV2 {
  const base = { name: v1.name, version: v1.version, scope: v1.scope };
  switch (table.form) {
    case 'foundation':
      return PackV2.parse({
        ...base,
        ...(v1.foundation !== undefined ? { foundation: v1.foundation } : {}),
      });
    case 'conformance': {
      const gates = v1.skills.flatMap((s) =>
        s.rules.map((r) => ruleToGate(r, triggerNames(s), table.onFail)),
      );
      if (gates.length === 0) {
        throw new Error(`migrateV1: conformance pack '${v1.name}' produced no gates`);
      }
      return PackV2.parse({ ...base, gates });
    }
    case 'behavior': {
      if (table.fsm === undefined) {
        // a behavior FSM is NOT derivable from the flat skills — it must be supplied (never synthesize).
        throw new Error(`migrateV1: behavior pack '${v1.name}' needs table.fsm`);
      }
      return PackV2.parse({ ...base, fsm: table.fsm });
    }
  }
}

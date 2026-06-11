/**
 * Auto-correct drift policy runtime (AUTO.4).
 *
 * Authoritative source: the automation planning notes [not retained — this header is the authority] AUTO.4.
 *
 * Lifecycle of an `auto_correct` verdict:
 *   1. Drift dispatcher emits `RuntimeAction{kind:'auto_correct', correctiveSkill, verdict}`.
 *   2. Caller invokes `runAutoCorrect()` with pack + evaluator + capability gate
 *      + a re-eval thunk for the offending rule.
 *   3. Capability gate fires FIRST (`subagent_call` for `correctiveSkill`).
 *      Gate denied → no invocation; fall-through descriptor returned.
 *   4. Corrective skill's process runs via the evaluator. Process error or
 *      drift verdict from the corrective skill itself → fall-through.
 *   5. Re-eval original rule. Drift persists → fall-through. Pass → emit a
 *      "corrected" pass verdict for the audit trail.
 *
 * LOOP CAP — 1 ATTEMPT MAX (locked).
 *   If the corrective skill (or the re-eval) ITSELF produces drift, we do
 *   NOT recurse — we return a fall-through descriptor so the caller routes
 *   to `notify_pause` / `escalate`. The cap is structural: no `attemptCount`
 *   parameter is accepted; there is no second attempt path to count to.
 *
 * NO SILENT FAIL-OPEN (C10):
 *   Every failure mode returns `corrected: false` with a structured
 *   `fallthrough` descriptor carrying a human-readable reason. The caller
 *   MUST route this to `notify_pause`. Function never silently swallows.
 *
 * Engine-vocabulary: pack / skill / verdict / capability only.
 */

import type { FunctionRegistry, EvalCtx } from '../functions/registry.js';

import type { CapabilityGate } from './capability_gate.js';
import { evaluateProcess } from './evaluator.js';
// T-ASC ASC.3: auto_correct only processes message-bearing verdicts. The
// directive-level verdict flows through the dispatcher's directives
// aggregation, not through the correction pipeline. Aliased to keep the
// existing source readable.
import type { MessageVerdict as Verdict, Pack, ProcessStep, RuleResult, Skill } from './types.js';

/**
 * `corrected: true` ⇒ caller treats the original verdict as resolved.
 * `correctionVerdict` carries a synthetic pass verdict for audit logs.
 *
 * `corrected: false` ⇒ caller MUST route to `notify_pause` (or `escalate`)
 * using `fallthrough.reason`. Loop cap forbids a second auto-correct.
 */
export interface AutoCorrectResult {
  corrected: boolean;
  correctionVerdict: Verdict | null;
  fallthrough?: {
    reason: string;
    kind:
      | 'capability_denied'
      | 'corrective_skill_missing'
      | 'corrective_skill_drift'
      | 'corrective_skill_error'
      | 'reeval_persistent_drift'
      | 'reeval_error';
  };
}

export interface AutoCorrectDeps {
  pack: Pack;
  correctiveSkill: string;
  verdict: Verdict;
  evalCtx: EvalCtx;
  registry: FunctionRegistry;
  capabilityGate: CapabilityGate;
  /**
   * Re-evaluate the rule that originally produced `verdict`. Caller owns
   * the thunk — the rule reference lives in the dispatcher layer, not here.
   */
  reevaluateOriginalRule: () => Promise<RuleResult>;
}

/**
 * Single linear pipeline (no recursion, no retry). Audit reads as: 1
 * capability check → 1 skill invocation → 1 re-eval → done. Every
 * fall-through path returns immediately.
 */
export async function runAutoCorrect(deps: AutoCorrectDeps): Promise<AutoCorrectResult> {
  const { pack, correctiveSkill, evalCtx, registry, capabilityGate, reevaluateOriginalRule } = deps;

  // 1. Capability gate FIRST — fail-early before any skill invocation.
  //    `subagent_call` gates one skill invoking another skill's process.
  //    Future caps (shell_exec / file_write) inside the corrective skill
  //    are gated separately by their primitives at process-step time.
  const gateVerdict = await capabilityGate.check({
    pack: pack.name,
    capability: 'subagent_call',
    target: correctiveSkill,
  });
  if (!gateVerdict.allowed) {
    return fallthrough(
      'capability_denied',
      `auto_correct denied: capability gate refused subagent_call → "${correctiveSkill}" (${gateVerdict.source})`,
    );
  }

  // 2. Resolve the corrective skill from the pack.
  const skill = findSkill(pack, correctiveSkill);
  if (!skill) {
    return fallthrough(
      'corrective_skill_missing',
      `auto_correct: corrective skill "${correctiveSkill}" not found in pack "${pack.name}"`,
    );
  }

  // 3. Invoke the corrective skill's process (track_check rules only;
  //    destination_check rules need scheduler context).
  const steps = collectProcessSteps(skill);
  if (steps.length === 0) {
    return fallthrough(
      'corrective_skill_missing',
      `auto_correct: corrective skill "${correctiveSkill}" has no runnable process steps`,
    );
  }

  let correctiveResult: RuleResult;
  try {
    correctiveResult = await evaluateProcess(steps, evalCtx, registry);
  } catch (e) {
    return fallthrough(
      'corrective_skill_error',
      `auto_correct: corrective skill "${correctiveSkill}" threw: ${String(e)}`,
    );
  }

  if (correctiveResult.kind === 'error') {
    return fallthrough(
      'corrective_skill_error',
      `auto_correct: corrective skill "${correctiveSkill}" failed at step ${correctiveResult.step}: ${correctiveResult.error}`,
    );
  }
  // LOOP CAP — corrective skill itself drifted. Do NOT recurse, do NOT
  // even re-eval. Surface and stop.
  if (correctiveResult.kind === 'verdict' && isDriftVerdict(correctiveResult.verdict)) {
    return fallthrough(
      'corrective_skill_drift',
      `auto_correct: corrective skill "${correctiveSkill}" itself produced drift (${correctiveResult.verdict.level}): ${correctiveResult.verdict.message}`,
    );
  }

  // 4. Re-eval the original rule.
  let reevalResult: RuleResult;
  try {
    reevalResult = await reevaluateOriginalRule();
  } catch (e) {
    return fallthrough('reeval_error', `auto_correct: re-eval threw: ${String(e)}`);
  }

  if (reevalResult.kind === 'error') {
    return fallthrough(
      'reeval_error',
      `auto_correct: re-eval failed at step ${reevalResult.step}: ${reevalResult.error}`,
    );
  }
  // LOOP CAP — drift persists. Do NOT auto-correct again.
  if (reevalResult.kind === 'verdict' && isDriftVerdict(reevalResult.verdict)) {
    return fallthrough(
      'reeval_persistent_drift',
      `auto_correct: drift persisted after correction (${reevalResult.verdict.level}): ${reevalResult.verdict.message}`,
    );
  }

  // 5. Success — synthetic "corrected" pass verdict for the audit trail.
  return {
    corrected: true,
    correctionVerdict: {
      level: 'pass',
      message: `auto_correct: drift resolved by corrective skill "${correctiveSkill}"`,
      ruleId: deps.verdict.ruleId,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers

function fallthrough(
  kind: NonNullable<AutoCorrectResult['fallthrough']>['kind'],
  reason: string,
): AutoCorrectResult {
  return { corrected: false, correctionVerdict: null, fallthrough: { kind, reason } };
}

function findSkill(pack: Pack, name: string): Skill | undefined {
  return pack.skills.find((s) => s.name === name);
}

// track_check rules only; destination_check rules need scheduler context.
function collectProcessSteps(skill: Skill): ProcessStep[] {
  const out: ProcessStep[] = [];
  for (const rule of skill.rules) {
    if (rule.kind === 'track_check') out.push(...rule.process);
  }
  return out;
}

// "Drift" = anything that isn't a pass.
function isDriftVerdict(v: Verdict): boolean {
  return v.level !== 'pass';
}

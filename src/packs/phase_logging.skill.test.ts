/**
 * Rule-FIRING test for `phase-logging` (T-RESPONSE-JUDGING-UPS RJ.2, 2026-06-01).
 *
 * Same rebuild as honesty-ledger: the 3 rules now trigger on prompt_submit and
 * detect their claim via text_pattern_match on priorAssistantText. Asserts each
 * fires through the evaluator (the gap that let the silent no-op ship).
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../functions/event.js';
import { FunctionRegistry } from '../functions/registry.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { ProcessStep, Rule, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/default-discipline');
const SID = 'pl-sess';

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg);
  registerVerdictFunctions(reg);
  reg.register(TextPatternMatch);
  return reg;
}

function promptSubmit(priorAssistantText: string): Event {
  return { kind: 'prompt_submit', prompt: 'next', priorAssistantText };
}

function run(steps: ProcessStep[], event: Event): Promise<RuleResult> {
  return evaluateProcess(
    steps,
    { event, bindings: new Map(), sessionId: SID, packId: 'default-discipline' },
    buildTestRegistry(),
  );
}

// FC.1b: the 3 phase-logging gates moved into default-discipline/guards (guard:<name>).
const GUARDS = 'default-discipline/guards';
const FIRING: Record<string, string> = {
  'guard:version-slot-assignment': 'this ships as v0.6.0',
  'guard:phase-claim-forward': 'Phase 5 — audit',
  'guard:session-no-task': "now I'll implement the fix",
};
const phaseRules = (rs: Rule[]): Rule[] => rs.filter((r) => r.id in FIRING);

describe('phase-logging (RJ.2 — fires at prompt_submit on priorAssistantText)', () => {
  it('compiles the 3 phase-logging guards under default-discipline/guards (prompt_submit)', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === GUARDS);
    expect(skill).toBeDefined();
    expect(skill?.triggers.map((t) => t.kind)).toContain('prompt_submit');
    const rules = phaseRules(skill?.rules ?? []);
    expect(rules).toHaveLength(3);
    expect(rules.map((r) => r.id).sort()).toEqual(Object.keys(FIRING).sort());
  });

  it('every phase-logging guard WARNS on a matching prior-assistant claim', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === GUARDS);
    for (const rule of phaseRules(skill?.rules ?? [])) {
      if (rule.kind !== 'track_check') throw new Error(`${rule.id} not track_check`);
      const text = FIRING[rule.id];
      if (text === undefined) throw new Error(`no fixture for ${rule.id}`);
      const r = await run(rule.process, promptSubmit(text));
      expect(r.kind, `${rule.id} should fire on "${FIRING[rule.id]}"`).toBe('verdict');
      if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
    }
  });

  it('every phase-logging guard is SILENT on unrelated prose', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === GUARDS);
    for (const rule of phaseRules(skill?.rules ?? [])) {
      if (rule.kind !== 'track_check') continue;
      const r = await run(rule.process, promptSubmit('just chatting about the weather'));
      expect(r.kind, `${rule.id} should be silent`).toBe('no_verdict');
    }
  });
});

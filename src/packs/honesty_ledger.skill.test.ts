/**
 * Rule-FIRING test for the honesty-ledger claim gates (T-RESPONSE-JUDGING-UPS RJ.2,
 * 2026-06-01; FC.1b 2026-06-03 — now compiled guards).
 *
 * Loads the REAL builtin `default-discipline` pack (proving the manifest `guards:`
 * parses + every `when:` compiles) and evaluates each of the 14 honesty-ledger
 * guards against a `prompt_submit` event carrying `priorAssistantText`.
 *
 * FC.1b: the 14 rules moved from the standalone `honesty-ledger` skill into the
 * synthetic `default-discipline/guards` skill (rule ids `guard:<name>`). The
 * firing behavior must be byte-identical — that is exactly what this asserts.
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
const GUARDS = 'default-discipline/guards';
const SID = 'hl-sess';

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

// One claim phrase per honesty-ledger guard that MUST match its regex (keyed by
// the compiled guard id `guard:<name>`).
const FIRING: Record<string, string> = {
  'guard:research-start': 'pre-research starting on the auth module',
  'guard:research-spawning': 'spawning a research agent for this',
  'guard:starting-now': 'starting now',
  'guard:running-tests': 'running the tests',
  'guard:running-build': 'build green',
  'guard:committed': 'I just committed the fix',
  'guard:audit-done': 'audit done',
  'guard:telegram-sent': 'telegram sent',
  'guard:pushed': 'pushed to origin',
  'guard:tagged': 'tagged v1.2.3',
  'guard:fmt-clippy': 'prettier clean',
  'guard:phase-logged': 'logged the audit phase',
  'guard:pre-push-checklist': 'gates green',
  'guard:ci-verify-after-push': 'CI green',
};

function honestyRules(skillRules: Rule[]): Rule[] {
  return skillRules.filter((r) => r.id in FIRING);
}

describe('honesty-ledger (RJ.2 — fires at prompt_submit on priorAssistantText)', () => {
  it('compiles the 14 claim guards under default-discipline/guards (prompt_submit)', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === GUARDS);
    expect(skill).toBeDefined();
    expect(skill?.triggers.map((t) => t.kind)).toContain('prompt_submit');
    const rules = honestyRules(skill?.rules ?? []);
    expect(rules).toHaveLength(14);
    expect(rules.map((r) => r.id).sort()).toEqual(Object.keys(FIRING).sort());
  });

  it('every honesty guard WARNS on a matching prior-assistant claim', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === GUARDS);
    for (const rule of honestyRules(skill?.rules ?? [])) {
      if (rule.kind !== 'track_check') throw new Error(`${rule.id} not track_check`);
      const text = FIRING[rule.id];
      if (text === undefined) throw new Error(`no fixture for ${rule.id}`);
      const r = await run(rule.process, promptSubmit(text));
      expect(r.kind, `${rule.id} should fire on "${text}"`).toBe('verdict');
      if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
    }
  });

  it('every honesty guard is SILENT on unrelated prose', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === GUARDS);
    for (const rule of honestyRules(skill?.rules ?? [])) {
      if (rule.kind !== 'track_check') continue;
      const r = await run(rule.process, promptSubmit('just thinking out loud about lunch'));
      expect(r.kind, `${rule.id} should be silent`).toBe('no_verdict');
    }
  });

  it('is SILENT when priorAssistantText is absent (no claim to judge)', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === GUARDS);
    const committed = skill?.rules.find((r) => r.id === 'guard:committed');
    if (committed?.kind !== 'track_check') throw new Error('guard:committed not track_check');
    const r = await run(committed.process, { kind: 'prompt_submit', prompt: 'next' });
    expect(r.kind).toBe('no_verdict');
  });
});

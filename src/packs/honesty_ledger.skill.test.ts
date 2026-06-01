/**
 * Rule-FIRING test for `honesty-ledger` (T-RESPONSE-JUDGING-UPS RJ.2, 2026-06-01).
 *
 * Loads the REAL builtin `default-discipline` pack (proving the skill.yaml parses
 * + every `if:` compiles) and evaluates each of the 14 rules against a
 * `prompt_submit` event carrying `priorAssistantText`.
 *
 * Why this test exists: honesty-ledger NEVER fired — it default-triggered on
 * tool_call and used `last_assistant_message` (null off-stop) + `match_command`
 * (tool_call-only, reads event.args not the binding). RJ.1 added priorAssistantText
 * at UPS; RJ.2 rebuilt the rules on `text_pattern_match`. These tests assert the
 * rules actually FIRE through the evaluator now — the coverage gap that let the
 * silent no-op ship.
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

// One claim phrase per rule that MUST match its regex.
const FIRING: Record<string, string> = {
  'research-start': 'pre-research starting on the auth module',
  'research-spawning': 'spawning a research agent for this',
  'starting-now': 'starting now',
  'running-tests': 'running the tests',
  'running-build': 'build green',
  committed: 'I just committed the fix',
  'audit-done': 'audit done',
  'telegram-sent': 'telegram sent',
  pushed: 'pushed to origin',
  tagged: 'tagged v1.2.3',
  'fmt-clippy': 'prettier clean',
  'phase-logged': 'logged the audit phase',
  'pre-push-checklist': 'gates green',
  'ci-verify-after-push': 'CI green',
};

let rules: Rule[];

describe('honesty-ledger (RJ.2 — fires at prompt_submit on priorAssistantText)', () => {
  it('loads with 14 rules and a prompt_submit trigger', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === 'honesty-ledger');
    expect(skill).toBeDefined();
    expect(skill?.triggers.map((t) => t.kind)).toEqual(['prompt_submit']);
    rules = skill?.rules ?? [];
    expect(rules).toHaveLength(14);
    // every rule id has a firing fixture
    expect(rules.map((r) => r.id).sort()).toEqual(Object.keys(FIRING).sort());
  });

  it('every rule WARNS on a matching prior-assistant claim', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === 'honesty-ledger');
    for (const rule of skill?.rules ?? []) {
      if (rule.kind !== 'track_check') throw new Error(`${rule.id} not track_check`);
      const text = FIRING[rule.id];
      if (text === undefined) throw new Error(`no fixture for ${rule.id}`);
      const r = await run(rule.process, promptSubmit(text));
      expect(r.kind, `${rule.id} should fire on "${text}"`).toBe('verdict');
      if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
    }
  });

  it('every rule is SILENT on unrelated prose', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === 'honesty-ledger');
    for (const rule of skill?.rules ?? []) {
      if (rule.kind !== 'track_check') continue;
      const r = await run(rule.process, promptSubmit('just thinking out loud about lunch'));
      expect(r.kind, `${rule.id} should be silent`).toBe('no_verdict');
    }
  });

  it('is SILENT when priorAssistantText is absent (no claim to judge)', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === 'honesty-ledger');
    const committed = skill?.rules.find((r) => r.id === 'committed');
    if (committed?.kind !== 'track_check') throw new Error('committed not track_check');
    const r = await run(committed.process, { kind: 'prompt_submit', prompt: 'next' });
    expect(r.kind).toBe('no_verdict');
  });
});

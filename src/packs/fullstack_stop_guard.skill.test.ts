/**
 * Rule-FIRING + schema-validation test for fullstack-flow's `stop-guard` skill (the kind:stop pause gate
 * v2 was missing). Mirrors `fullstack_pause_guard.skill.test.ts`: load the skill, run its rule via
 * `evaluateProcess` with `packFsm` threaded (read_fsm_state → the FSM `initial`), and a CONTROLLED
 * `open_task_count` stub so the predicate `phase != "scope" && open.count > 0` is tested on both branches.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerFsmFunctions } from '../functions/fsm.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { Fsm } from '../runtime/fsm.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { Skill } from './schemas/skill.js';
import { parseYamlFile } from './yaml.js';

const HERE = fileURLToPath(import.meta.url);
const SKILL_PATH = resolve(HERE, '../../../packs/builtin/fullstack-flow/skills/stop-guard/skill.yaml');

const STATES = ['scope', 'plan', 'author', 'code', 'deploy', 'accept', 'done'];
const fsmAt = (initial: string): Fsm => ({ initial, states: STATES, transitions: [] });

let n = 0;
// CONTROLLED stubs: the predicate branches on `open.count` and `automation.value`, so we drive both
// per case (open_task_count by `count`, is_automation_mode by `automation`).
function registry(count: number, automation: boolean): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerFsmFunctions(reg); // read_fsm_state
  registerVerdictFunctions(reg); // verdict
  reg.register({
    name: 'open_task_count',
    argSchema: z.object({}),
    durable: false,
    memoizable: false,
    costEstimateMs: 1,
    execute: async () => ({ ok: true, value: { count } }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  reg.register({
    name: 'is_automation_mode',
    argSchema: z.object({}),
    durable: false,
    memoizable: false,
    costEstimateMs: 1,
    execute: async () => ({ ok: true, value: { value: automation, source: automation ? 'flag' : 'none' } }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return reg;
}

const stopEvent = (): Event => ({ kind: 'stop', assistantText: '' } as unknown as Event);

async function loadSkill(): Promise<Skill> {
  const { data } = await parseYamlFile(SKILL_PATH, Skill);
  return data as Skill;
}

async function ruleSteps(): Promise<ProcessStep[]> {
  const skill = await loadSkill();
  const rule = skill.rules.find((r) => r.id === 'no-stop-mid-run');
  if (rule?.kind !== 'track_check') throw new Error('stop-guard rule not a track_check');
  return rule.process;
}

function run(steps: ProcessStep[], count: number, packFsm: Fsm, automation = true): Promise<RuleResult> {
  return evaluateProcess(
    steps,
    { event: stopEvent(), bindings: new Map(), sessionId: `stop-guard-${String(n++)}`, packId: 'fullstack-flow', packFsm },
    registry(count, automation),
  );
}

describe('fullstack-flow stop-guard', () => {
  it('validates against the Skill schema: preload, kind:stop trigger, one rule', async () => {
    const skill = await loadSkill();
    expect(skill.name).toBe('stop-guard');
    expect(skill.load).toBe('preload');
    expect(skill.triggers.map((t) => t.kind)).toEqual(['stop']);
    expect(skill.rules).toHaveLength(1);
    expect(skill.rules[0]?.id).toBe('no-stop-mid-run');
  });

  it('AUTOMATION + stop MID-RUN (phase != scope, backlog non-empty) → BLOCKED', async () => {
    const r = await run(await ruleSteps(), 2, fsmAt('code'), true);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.level).toBe('block');
      expect(r.verdict.message).toContain('stopped mid-run');
    }
  });

  it('INTERACTIVE (automation.value=false) + stop MID-RUN → ALLOWED (the misfire this fixes)', async () => {
    const r = await run(await ruleSteps(), 2, fsmAt('code'), false);
    expect(r.kind).toBe('no_verdict');
  });

  it('AUTOMATION + stop IN SCOPE (phase == scope) → ALLOWED (no verdict), even with open tasks', async () => {
    const r = await run(await ruleSteps(), 2, fsmAt('scope'), true);
    expect(r.kind).toBe('no_verdict');
  });

  it('AUTOMATION + stop on a DEPLETED run (phase != scope, zero open tasks) → ALLOWED (no verdict)', async () => {
    const r = await run(await ruleSteps(), 0, fsmAt('code'), true);
    expect(r.kind).toBe('no_verdict');
  });
});

/**
 * H5 — rule-FIRING + schema-validation test for fullstack-flow's SPLIT pause-guard skills.
 *
 * The v2 state-keyed model: pause-discipline is gated by the per-state BINDING (pack.yaml binds these skills
 * ONLY to the post-scope gates, never `scope`), so the rules carry NO in-rule phase check. The split into two
 * skills is forced: a rule cannot tell which event kind fired it (evalCondition reads ctx.bindings only; there is
 * no event_kind accessor), so a single skill's unconditional stop-rule would also fire on every tool_call. Hence:
 *   - pause-guard-tool: trigger `tool_call`; binds `tool_name` then `verdict block` iff tool ∈ {AskUserQuestion, Stop}.
 *   - pause-guard-stop: trigger `stop`; UNCONDITIONAL `verdict block` (the trigger + binding are the gates).
 *
 * Deterministic + zero-LLM. No `read_fsm_state` / packFsm needed (binding gates phase).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../functions/event.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { Skill } from './schemas/skill.js';
import { parseYamlFile } from './yaml.js';

const HERE = fileURLToPath(import.meta.url);
const skillPath = (name: string): string =>
  resolve(HERE, `../../../packs/builtin/fullstack-flow/skills/${name}/skill.yaml`);

let n = 0;
function buildRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // tool_name
  registerVerdictFunctions(reg); // verdict
  return reg;
}

async function loadSkill(name: string): Promise<Skill> {
  const { data } = await parseYamlFile(skillPath(name), Skill);
  return data as Skill;
}

async function ruleSteps(skillName: string, ruleId: string): Promise<ProcessStep[]> {
  const skill = await loadSkill(skillName);
  const rule = skill.rules.find((r) => r.id === ruleId);
  if (rule?.kind !== 'track_check') throw new Error(`${skillName} rule not a track_check`);
  return rule.process;
}

function run(steps: ProcessStep[], event: Event): Promise<RuleResult> {
  return evaluateProcess(
    steps,
    {
      event,
      bindings: new Map(),
      sessionId: `pause-guard-${String(n++)}`,
      packId: 'fullstack-flow',
    },
    buildRegistry(),
  );
}

const toolCall = (tool: string): Event => ({ kind: 'tool_call', tool, args: {} });
const stopEvent = (): Event => ({ kind: 'stop' }) as unknown as Event;

describe('fullstack-flow pause-guard-tool (H5)', () => {
  it('validates: preload, tool_call trigger, one rule', async () => {
    const skill = await loadSkill('pause-guard-tool');
    expect(skill.name).toBe('pause-guard-tool');
    expect(skill.load).toBe('preload');
    expect(skill.triggers.map((t) => t.kind)).toEqual(['tool_call']);
    expect(skill.rules[0]?.id).toBe('no-pause-tool');
  });

  it('AskUserQuestion → BLOCKED (binding guarantees post-scope; no in-rule phase check)', async () => {
    const r = await run(
      await ruleSteps('pause-guard-tool', 'no-pause-tool'),
      toolCall('AskUserQuestion'),
    );
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.level).toBe('block');
      expect(r.verdict.message).toContain('Past SCOPE there are no pauses');
    }
  });

  it('Stop tool → BLOCKED', async () => {
    const r = await run(await ruleSteps('pause-guard-tool', 'no-pause-tool'), toolCall('Stop'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('a non-pause tool → NEVER blocked (no verdict)', async () => {
    const r = await run(await ruleSteps('pause-guard-tool', 'no-pause-tool'), toolCall('Edit'));
    expect(r.kind).toBe('no_verdict');
  });
});

describe('fullstack-flow pause-guard-stop (H5)', () => {
  it('validates: preload, stop trigger, one rule', async () => {
    const skill = await loadSkill('pause-guard-stop');
    expect(skill.name).toBe('pause-guard-stop');
    expect(skill.load).toBe('preload');
    expect(skill.triggers.map((t) => t.kind)).toEqual(['stop']);
    expect(skill.rules[0]?.id).toBe('no-stop-event');
  });

  it('a stop event → BLOCKED unconditionally (trigger + binding are the gates)', async () => {
    const r = await run(await ruleSteps('pause-guard-stop', 'no-stop-event'), stopEvent());
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.level).toBe('block');
      expect(r.verdict.message).toContain('Past SCOPE there are no pauses');
    }
  });
});

/**
 * T2.9 — rule-FIRING + schema-validation test for fullstack-flow's `pause-guard` skill.
 *
 * The fullstack-flow pause discipline (the ≥v1 floor): a real-time pause ACTION (AskUserQuestion / Stop)
 * is allowed ONLY in the SCOPE stage; PAST SCOPE it is HARD-BLOCKED. The rule reads the fullstack-flow FSM
 * state via `read_fsm_state` (bound `as: phase`) and matches the tool name (event.tool) against the
 * pause-action set via `text_pattern_match`, then `verdict`s `level: block` when both hold.
 *
 * AUTOMATION-GATED (mirrors stop-guard / d9-guard): the block only fires when `is_automation_mode`
 * returns `value: true`. In an interactive session the guard is a true no-op — a legitimate
 * AskUserQuestion in an interactive session must never be blocked by this rule.
 *
 * Deterministic + zero-LLM: no real LLM, no DB, no disk writes. The FSM phase is injected as `ctx.packFsm`
 * exactly as the dispatcher threads it (src/runtime/hooks/dispatch.ts), with a FRESH sessionId per case so
 * `read_fsm_state` returns the FSM's `initial` (no persisted state) — `scope` for the in-scope FSM and
 * `code` (a post-scope state) for the post-scope FSM.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerEventFunctions } from '../functions/event.js';
import { registerFsmFunctions } from '../functions/fsm.js';
import { FunctionRegistry, type FunctionDef } from '../functions/registry.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { Fsm } from '../runtime/fsm.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { Skill } from './schemas/skill.js';
import { parseYamlFile } from './yaml.js';

const HERE = fileURLToPath(import.meta.url);
const SKILL_PATH = resolve(
  HERE,
  '../../../packs/builtin/fullstack-flow/skills/pause-guard/skill.yaml',
);

// The fullstack-flow lifecycle states (pack.yaml `fsm:`). `initial` is the only field that varies the
// in-scope vs post-scope case (a fresh sessionId → read_fsm_state returns `initial`).
const STATES = ['scope', 'plan', 'author', 'code', 'deploy', 'accept', 'done'];
const fsmAt = (initial: string): Fsm => ({ initial, states: STATES, transitions: [] });

let n = 0;
// CONTROLLED stubs: `is_automation_mode` is now gating the verdict; drive both branches per case.
function buildRegistry(automation = true): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // tool_name (unused here) — harmless
  registerFsmFunctions(reg); // read_fsm_state
  registerVerdictFunctions(reg); // verdict
  reg.register(TextPatternMatch); // text_pattern_match
  reg.register({
    name: 'is_automation_mode',
    argSchema: z.object({}).passthrough(),
    durable: false,
    memoizable: false,
    costEstimateMs: 0,
    execute: () =>
      Promise.resolve({
        ok: true,
        value: { value: automation, source: automation ? 'env' : 'none' },
      }),
  } as unknown as FunctionDef<unknown, unknown>);
  return reg;
}

function toolCall(tool: string): Event {
  return { kind: 'tool_call', tool, args: {} };
}

async function loadSkill(): Promise<Skill> {
  // `Skill` is a ZodObject whose input ≠ output (it has `.default()`s), so it isn't a `z.ZodType<Skill>`;
  // parse with the schema (which still VALIDATES the file against the schema) and assert the output type.
  const { data } = await parseYamlFile(SKILL_PATH, Skill);
  return data as Skill;
}

async function ruleSteps(): Promise<ProcessStep[]> {
  const skill = await loadSkill();
  const rule = skill.rules.find((r) => r.id === 'no-pause-past-scope');
  if (rule?.kind !== 'track_check') throw new Error('pause-guard rule not a track_check');
  return rule.process;
}

function run(
  steps: ProcessStep[],
  event: Event,
  packFsm: Fsm,
  automation = true,
): Promise<RuleResult> {
  return evaluateProcess(
    steps,
    {
      event,
      bindings: new Map(),
      sessionId: `pause-guard-${String(n++)}`,
      packId: 'fullstack-flow',
      packFsm,
    },
    buildRegistry(automation),
  );
}

describe('fullstack-flow pause-guard (T2.9)', () => {
  it('validates against the Skill schema: preload, tool_call trigger, one rule', async () => {
    const skill = await loadSkill();
    expect(skill.name).toBe('pause-guard');
    expect(skill.load).toBe('preload');
    expect(skill.triggers.map((t) => t.kind)).toEqual(['tool_call']);
    expect(skill.rules).toHaveLength(1);
    expect(skill.rules[0]?.id).toBe('no-pause-past-scope');
  });

  // ── IN-SCOPE cases — always ALLOWED regardless of automation mode ─────────────────────────────

  it('AUTOMATION + AskUserQuestion IN SCOPE (phase == scope) → ALLOWED (no verdict)', async () => {
    const r = await run(await ruleSteps(), toolCall('AskUserQuestion'), fsmAt('scope'), true);
    expect(r.kind).toBe('no_verdict');
  });

  it('AUTOMATION + Stop IN SCOPE (phase == scope) → ALLOWED (no verdict)', async () => {
    const r = await run(await ruleSteps(), toolCall('Stop'), fsmAt('scope'), true);
    expect(r.kind).toBe('no_verdict');
  });

  // ── POST-SCOPE + AUTOMATION — the driven-loop block must fire ────────────────────────────────

  it('AUTOMATION + AskUserQuestion POST-SCOPE (phase != scope) → BLOCKED', async () => {
    const r = await run(await ruleSteps(), toolCall('AskUserQuestion'), fsmAt('code'), true);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') {
      expect(r.verdict.level).toBe('block');
      expect(r.verdict.message).toContain('Past SCOPE there are no pauses');
    }
  });

  it('AUTOMATION + Stop POST-SCOPE (phase != scope) → BLOCKED', async () => {
    const r = await run(await ruleSteps(), toolCall('Stop'), fsmAt('author'), true);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  // ── POST-SCOPE + INTERACTIVE — the guard must be a true no-op (the misfire this fixes) ───────

  it('INTERACTIVE (automation.value=false) + AskUserQuestion POST-SCOPE → ALLOWED (the misfire this fixes)', async () => {
    const r = await run(await ruleSteps(), toolCall('AskUserQuestion'), fsmAt('code'), false);
    expect(r.kind).toBe('no_verdict');
  });

  it('INTERACTIVE (automation.value=false) + Stop POST-SCOPE → ALLOWED (never blocks interactive sessions)', async () => {
    const r = await run(await ruleSteps(), toolCall('Stop'), fsmAt('author'), false);
    expect(r.kind).toBe('no_verdict');
  });

  // ── Non-pause tools — always ALLOWED ─────────────────────────────────────────────────────────

  it('a non-pause tool POST-SCOPE → NEVER blocked (no verdict)', async () => {
    const r = await run(await ruleSteps(), toolCall('Edit'), fsmAt('code'), true);
    expect(r.kind).toBe('no_verdict');
  });

  it('a non-pause tool IN SCOPE → NEVER blocked (no verdict)', async () => {
    const r = await run(await ruleSteps(), toolCall('Bash'), fsmAt('scope'), true);
    expect(r.kind).toBe('no_verdict');
  });
});

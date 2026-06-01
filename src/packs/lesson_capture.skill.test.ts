/**
 * Rule-FIRING test for cycle-pack `lesson-capture` (T-RJ-FOLLOWUPS FU.2).
 *
 * lesson-capture default-triggered on tool_call and fed `llm_classify` a
 * CONTENTLESS prompt ("inspect the last few turns" with nothing interpolated).
 * FU.2 retriggers it on prompt_submit and interpolates the settled recent turns
 * (`recent_turns` → `{{turns}}`). Stubs `llm_classify` to capture the prompt and
 * assert the turns actually reach it (the prior bug), plus the NONE→pass path.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerEventFunctions } from '../functions/event.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import { ok } from '../runtime/result.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/cycle-pack');
const SID = 'lc-sess';

function buildRegistry(label: string, capture: { prompt?: string }): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // recent_turns
  registerVerdictFunctions(reg); // verdict
  reg.register({
    name: 'llm_classify',
    argSchema: z
      .object({ model: z.string(), prompt: z.string(), allowed_labels: z.array(z.string()) })
      .passthrough(),
    durable: false,
    memoizable: false,
    costEstimateMs: 0,
    execute: (args) => {
      capture.prompt = args.prompt;
      return Promise.resolve(ok(label));
    },
  });
  return reg;
}

function promptSubmit(recentTurns: string): Event {
  return { kind: 'prompt_submit', prompt: 'next', recentTurns };
}

async function steps(): Promise<ProcessStep[]> {
  const pack = await loadPack(PACK);
  const skill = pack.skills.find((s) => s.name === 'lesson-capture');
  const rule = skill?.rules.find((r) => r.id === 'triage');
  if (rule?.kind !== 'track_check') throw new Error('lesson-capture triage rule not a track_check');
  return rule.process;
}

function run(s: ProcessStep[], event: Event, reg: FunctionRegistry): Promise<RuleResult> {
  return evaluateProcess(
    s,
    { event, bindings: new Map(), sessionId: SID, packId: 'cycle-pack' },
    reg,
  );
}

describe('lesson-capture (FU.2 — fires at prompt_submit, classifier sees the turns)', () => {
  it('triggers on prompt_submit and its first step captures recent_turns', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === 'lesson-capture');
    expect(skill?.triggers.map((t) => t.kind)).toEqual(['prompt_submit']);
    const triage = skill?.rules.find((r) => r.id === 'triage');
    if (triage?.kind !== 'track_check') throw new Error('not track_check');
    expect(triage.process[0]?.call).toBe('recent_turns');
  });

  it('interpolates the recent turns into the classifier prompt (the contentless-prompt fix)', async () => {
    const capture: { prompt?: string } = {};
    const turns = 'User: how do I deploy?\n\nAssistant: run the deploy script';
    const r = await run(await steps(), promptSubmit(turns), buildRegistry('NONE', capture));
    expect(capture.prompt).toContain(turns); // the turns actually reached the model
    expect(r.kind).toBe('verdict'); // NONE → pass verdict
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('pass');
  });

  it('a lesson label (not NONE) yields no pass verdict', async () => {
    const capture: { prompt?: string } = {};
    const r = await run(
      await steps(),
      promptSubmit('User: x\n\nAssistant: y'),
      buildRegistry('WORKFLOW', capture),
    );
    expect(r.kind).toBe('no_verdict');
  });
});

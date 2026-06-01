/**
 * Rule-FIRING test for `d9-guard` (T-RESPONSE-JUDGING-UPS RJ.3, 2026-06-01).
 *
 * d9-guard judges the assistant's just-ended turn for a politeness reflex in
 * automation mode. RJ.3 moved it from Stop → UserPromptSubmit and fixed the
 * CONTENTLESS-prompt bug: it now captures the settled prior turn
 * (priorAssistantText) into `msg` and interpolates it into the classifier
 * prompt via `{{msg}}`.
 *
 * Stubs `is_automation_mode` + `llm_classify` so the test is deterministic and
 * makes no real LLM call. The key assertion is that the classifier prompt
 * actually CONTAINS the prior message (proving the interpolation that the prior
 * implementation lacked).
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
const PACK = resolve(HERE, '../../../packs/builtin/default-discipline');
const SID = 'd9-sess';

interface StubOpts {
  automation: boolean;
  label: 'ALLOW' | 'BLOCK';
  capture: { prompt?: string; called: boolean };
}

function buildRegistry(opts: StubOpts): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // last_assistant_message
  registerVerdictFunctions(reg); // verdict
  reg.register({
    name: 'is_automation_mode',
    argSchema: z.object({}).passthrough(),
    durable: false,
    memoizable: false,
    costEstimateMs: 0,
    execute: () =>
      Promise.resolve(ok({ value: opts.automation, source: opts.automation ? 'env' : 'none' })),
  });
  reg.register({
    name: 'llm_classify',
    argSchema: z
      .object({ model: z.string(), prompt: z.string(), allowed_labels: z.array(z.string()) })
      .passthrough(),
    durable: false,
    memoizable: false,
    costEstimateMs: 0,
    execute: (args) => {
      opts.capture.called = true;
      opts.capture.prompt = args.prompt;
      return Promise.resolve(ok(opts.label));
    },
  });
  return reg;
}

function promptSubmit(priorAssistantText: string): Event {
  return { kind: 'prompt_submit', prompt: 'next', priorAssistantText };
}

async function steps(): Promise<ProcessStep[]> {
  const pack = await loadPack(PACK);
  const skill = pack.skills.find((s) => s.name === 'd9-guard');
  const rule = skill?.rules.find((r) => r.id === 'd9-blocking-question-check');
  if (rule?.kind !== 'track_check') throw new Error('d9-guard rule not a track_check');
  return rule.process;
}

function run(s: ProcessStep[], event: Event, reg: FunctionRegistry): Promise<RuleResult> {
  return evaluateProcess(
    s,
    { event, bindings: new Map(), sessionId: SID, packId: 'default-discipline' },
    reg,
  );
}

describe('d9-guard (RJ.3 — fires at prompt_submit, classifier sees the message)', () => {
  it('loads with one rule, a prompt_submit trigger, and prompt_submit when_to_load', async () => {
    const pack = await loadPack(PACK);
    const skill = pack.skills.find((s) => s.name === 'd9-guard');
    expect(skill?.triggers.map((t) => t.kind)).toEqual(['prompt_submit']);
    expect(skill?.when_to_load).toEqual([{ kind: 'event_type', type: 'prompt_submit' }]);
    expect(skill?.rules).toHaveLength(1);
  });

  it('automation OFF → no classifier call, no verdict (true no-op)', async () => {
    const capture: { prompt?: string; called: boolean } = { called: false };
    const opts: StubOpts = { automation: false, label: 'BLOCK', capture };
    const r = await run(
      await steps(),
      promptSubmit('Want me to also refactor X?'),
      buildRegistry(opts),
    );
    expect(capture.called).toBe(false); // gated — classifier never invoked
    expect(r.kind).toBe('no_verdict');
  });

  it('automation ON + politeness reflex (BLOCK) → warn, and the classifier prompt CONTAINS the message', async () => {
    const capture: { prompt?: string; called: boolean } = { called: false };
    const opts: StubOpts = { automation: true, label: 'BLOCK', capture };
    const msg = 'Want me to also refactor the helper, or should I leave it?';
    const r = await run(await steps(), promptSubmit(msg), buildRegistry(opts));

    expect(capture.called).toBe(true);
    // The prior-implementation bug: the prompt referenced "the message below"
    // but never interpolated it. Assert the message actually reached the model.
    expect(capture.prompt).toContain(msg);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
  });

  it('automation ON + genuine blocking question (ALLOW) → no verdict', async () => {
    const capture: { prompt?: string; called: boolean } = { called: false };
    const opts: StubOpts = { automation: true, label: 'ALLOW', capture };
    const r = await run(
      await steps(),
      promptSubmit('Which database — Postgres or MySQL?'),
      buildRegistry(opts),
    );
    expect(capture.called).toBe(true);
    expect(r.kind).toBe('no_verdict');
  });
});

/**
 * M.2 — migrateV1 + the per-path behavioral-equivalence harness.
 *
 * The anti-bug keystone: a migrated `track_check` gate's `process` is a faithful copy of the v1 rule's
 * steps (`PackV2.parse` re-validates them), so running BOTH through the SAME `evaluateProcess` over one
 * event yields an IDENTICAL `RuleResult`. The `destination_check` path is field-verbatim (it never
 * touches `evaluateProcess` — `dispatch.ts:379` skips it). Foundation + behavior forms + fail-loud cases.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FunctionRegistry, type EvalCtx, type FunctionDef } from '../functions/registry.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import { ok } from '../runtime/result.js';
import { Pack, type Event, type ProcessStep } from '../runtime/types.js';

import { migrateV1, type MigrationTable } from './migrate_v1_to_v2.js';

// A `verdict` primitive (mirrors evaluator.test.ts) so a track_check process can reach a terminal verdict.
const verdictDef: FunctionDef<{ level: string; message: string }, unknown> = {
  name: 'verdict',
  argSchema: z.object({ level: z.string(), message: z.string() }),
  execute: (args) => Promise.resolve(ok({ level: args.level, message: args.message })),
};

function ctx(overrides: Partial<EvalCtx> = {}): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return { event, bindings: new Map(), sessionId: 's', packId: 'p', ...overrides };
}

// A representative v1 track_check process: an `if`-guarded step + a terminal verdict.
const TRACK_PROCESS: ProcessStep[] = [
  { call: 'verdict', args: { level: 'block', message: 'phase not logged before commit' } },
];

function v1ConformancePack(): Pack {
  return Pack.parse({
    name: 'default-discipline',
    version: '1.0.0',
    scope: 'universal',
    goal: 'keep the agent on-track',
    skills: [
      {
        name: 'phase-discipline',
        triggers: [{ kind: 'tool_call' }, { kind: 'stop' }],
        rules: [
          { id: 'phase-logged-before-commit', kind: 'track_check', process: TRACK_PROCESS },
          {
            id: 'destination-on-track',
            kind: 'destination_check',
            interval: { every_n_tool_calls: 10 },
            model_alias: 'reasoning',
            prompt_template: 'Are we still on the stated track?',
          },
        ],
      },
    ],
  });
}

describe('migrateV1 — conformance form (gates) + per-path behavioral equivalence', () => {
  const v1 = v1ConformancePack();
  const table: MigrationTable = {
    form: 'conformance',
    onFail: (id) =>
      id === 'phase-logged-before-commit'
        ? { action: 'block', message: 'log the phase first' }
        : undefined,
  };
  const v2 = migrateV1(v1, table);

  it('produces a conformance pack — gates, no fsm', () => {
    expect(v2.fsm).toBeUndefined();
    expect(v2.gates).toHaveLength(2);
  });

  it('re-homes the track_check rule with trigger from the skill + process VERBATIM', () => {
    const gate = v2.gates?.[0];
    expect(gate).toMatchObject({
      kind: 'track_check',
      trigger: ['tool_call', 'stop'],
      on_fail: { action: 'block', message: 'log the phase first' },
    });
    // structural identity: PackV2.parse re-validates (fail-loud), so the steps are a faithful copy of
    // the v1 process — deep-equal (not ===). Behavioral identity is proven by the equivalence test below.
    expect(gate?.kind === 'track_check' && gate.process).toEqual(TRACK_PROCESS);
  });

  it('BEHAVIORAL EQUIVALENCE: v1 rule.process and migrated gate.process → IDENTICAL RuleResult', async () => {
    const reg = new FunctionRegistry();
    reg.register(verdictDef);
    const v1Rule = v1.skills[0]?.rules[0];
    const gate = v2.gates?.[0];
    if (v1Rule?.kind !== 'track_check' || gate?.kind !== 'track_check') {
      throw new Error('fixture must yield two track_check forms');
    }
    const v1Result = await evaluateProcess(v1Rule.process, ctx(), reg);
    const v2Result = await evaluateProcess(gate.process, ctx(), reg);
    expect(v2Result).toEqual(v1Result);
    expect(v2Result).toEqual({
      kind: 'verdict',
      verdict: { level: 'block', message: TRACK_PROCESS[0]?.args?.message },
    });
  });

  it('flattens the destination_check rule field-verbatim (no evaluateProcess on this path)', () => {
    const gate = v2.gates?.[1];
    expect(gate).toEqual({
      kind: 'destination_check',
      prompt_template: 'Are we still on the stated track?',
      every_n_tool_calls: 10,
      model_alias: 'reasoning',
    });
  });
});

describe('migrateV1 — foundation form', () => {
  it('passes the foundation block through; no fsm, no gates', () => {
    const v1 = Pack.parse({
      name: 'focused-typescript-strict',
      version: '1.0.0',
      scope: 'specialty',
      goal: 'strict TS expertise',
      foundation: { domains: ['typescript'], methodologies: ['strict-mode'] },
    });
    const v2 = migrateV1(v1, { form: 'foundation' });
    expect(v2.fsm).toBeUndefined();
    expect(v2.gates).toBeUndefined();
    expect(v2.foundation).toEqual({
      tools: [],
      domains: ['typescript'],
      methodologies: ['strict-mode'],
    });
  });
});

describe('migrateV1 — behavior form (fsm from the side-file)', () => {
  it('carries table.fsm; transitions SET-EQUAL the supplied fsm (the round-trip shape)', () => {
    const v1 = Pack.parse({
      name: 'coding-flow',
      version: '1.0.0',
      scope: 'workflow',
      goal: 'gate the coding flow',
    });
    const fsm = {
      initial: 'idle',
      states: {
        idle: {
          kind: 'executor' as const,
          skills: [],
          directive: 'start',
          completion: 'ok',
          emits: 'go',
        },
        done: { kind: 'terminal' as const, outcome: 'shipped' as const },
      },
      transitions: [{ from: 'idle', on: 'go', to: 'done' }],
    };
    const v2 = migrateV1(v1, { form: 'behavior', fsm });
    expect(v2.gates).toBeUndefined();
    expect(new Set(v2.fsm?.transitions)).toEqual(new Set(fsm.transitions));
  });
});

describe('migrateV1 — fail-loud (never heuristic)', () => {
  it('throws on a behavior pack with no table.fsm', () => {
    const v1 = Pack.parse({ name: 'b', version: '1.0.0', scope: 'workflow', goal: 'g' });
    expect(() => migrateV1(v1, { form: 'behavior' })).toThrow(/needs table\.fsm/);
  });

  it('throws on a conformance pack with zero rules (no gates produced)', () => {
    const v1 = Pack.parse({
      name: 'empty',
      version: '1.0.0',
      scope: 'universal',
      goal: 'g',
      skills: [{ name: 's', triggers: [{ kind: 'tool_call' }], rules: [] }],
    });
    expect(() => migrateV1(v1, { form: 'conformance' })).toThrow(/produced no gates/);
  });
});

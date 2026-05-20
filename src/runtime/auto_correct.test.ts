/* eslint-disable @typescript-eslint/require-await */
/**
 * Tests for `runAutoCorrect` (AUTO.4).
 *
 * Coverage:
 *   1. Happy path — corrective skill runs, re-eval passes → corrected: true.
 *   2. Capability-denied — gate refuses subagent_call → fall-through
 *      (`capability_denied`), NO invocation, NO re-eval.
 *   3. Capability gate fires BEFORE skill invocation (order check).
 *   4. Pack-local subagent deny → capability_denied.
 *   5. Corrective skill missing → corrective_skill_missing.
 *   6. Corrective skill has no track_check rules → corrective_skill_missing.
 *   7. Corrective skill produces drift → corrective_skill_drift
 *      (LOOP CAP: no recursion, no re-eval).
 *   8. Re-eval still drifts → reeval_persistent_drift
 *      (LOOP CAP: no second auto_correct attempt).
 *   9. Corrective primitive throws → corrective_skill_error.
 *   10. Re-eval thunk throws → reeval_error.
 *
 * `require-await` disabled file-wide: test FunctionDef stubs are pure but
 * the contract requires `async`; matches the pattern in functions/verdict.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ok } from '../runtime/result.js';
import { FunctionRegistry } from '../functions/registry.js';
import type { EvalCtx } from '../functions/registry.js';

import type { PackPermissions } from './capability_gate.js';
import { CapabilityGate } from './capability_gate.js';
import { runAutoCorrect } from './auto_correct.js';
import type { Event, Pack, RuleResult, Verdict } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures

const evt: Event = { kind: 'tool_call', tool: 'Edit', args: {} };
const baseCtx: EvalCtx = {
  event: evt,
  bindings: new Map(),
  sessionId: 's',
  packId: 'test-pack',
};

const baseVerdict: Verdict = {
  level: 'block',
  message: 'format violation',
  ruleId: 'format-violation',
};

const passResult: RuleResult = {
  kind: 'verdict',
  verdict: { level: 'pass', message: 'fixed' },
};

const VerdictArgs = z
  .object({ level: z.enum(['pass', 'block', 'warn', 'surface']), message: z.string() })
  .strict();

function makeRegistry(opts: { throwOnRun?: boolean } = {}): {
  registry: FunctionRegistry;
  invocations: { count: number };
} {
  const registry = new FunctionRegistry();
  const invocations = { count: 0 };
  registry.register({
    name: 'corrective_op',
    argSchema: z.object({}).strict(),
    execute: async () => {
      invocations.count += 1;
      if (opts.throwOnRun) throw new Error('corrective_op blew up');
      return ok({ ran: true });
    },
  });
  registry.register({
    name: 'verdict',
    argSchema: VerdictArgs,
    execute: async ({ level, message }) => ok({ level, message }),
  });
  return { registry, invocations };
}

function makePack(opts: {
  correctiveSkillName?: string;
  correctiveSkillDrifts?: boolean;
  noProcessSteps?: boolean;
}): Pack {
  const skillName = opts.correctiveSkillName ?? 'auto-format-skill';
  const driftStep = {
    call: 'verdict' as const,
    args: { level: 'block', message: 'corrective skill itself drifted' },
  };
  const opStep = { call: 'corrective_op' as const, args: {} };
  const steps = opts.noProcessSteps ? [] : opts.correctiveSkillDrifts ? [driftStep] : [opStep];
  return {
    name: 'test-pack',
    version: '0.0.1',
    scope: 'project',
    goal: 'test',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [
      {
        name: skillName,
        load: 'lazy',
        when_to_load: [],
        unloads_when: [],
        triggers: [{ kind: 'tool_call' }],
        rules: [{ id: 'corrective-rule', kind: 'track_check', process: steps }],
      },
    ],
  };
}

function makeGate(perms?: {
  subagent_call?: { targets: string[]; deny: string[] };
}): CapabilityGate {
  const packs = new Map<string, PackPermissions>([
    ['test-pack', perms ? { name: 'test-pack', permissions: perms } : { name: 'test-pack' }],
  ]);
  return new CapabilityGate({ packs, trustBuiltinDeny: true, homeDir: '/tmp/test' });
}

// ---------------------------------------------------------------------------
// Happy path

describe('runAutoCorrect — happy path', () => {
  it('runs corrective skill, re-evaluates, returns corrected: true', async () => {
    const { registry, invocations } = makeRegistry();
    const result = await runAutoCorrect({
      pack: makePack({}),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({ subagent_call: { targets: ['auto-format-skill'], deny: [] } }),
      reevaluateOriginalRule: () => Promise.resolve(passResult),
    });
    expect(result.corrected).toBe(true);
    expect(invocations.count).toBe(1);
    expect(result.correctionVerdict?.level).toBe('pass');
    expect(result.correctionVerdict?.ruleId).toBe('format-violation');
  });
});

// ---------------------------------------------------------------------------
// Capability gate (AUTO.3 integration)

describe('runAutoCorrect — capability gate', () => {
  it('undeclared subagent_call → fall-through, NO invocation, NO re-eval', async () => {
    const { registry, invocations } = makeRegistry();
    const reeval = vi.fn(() => Promise.resolve(passResult));
    const result = await runAutoCorrect({
      pack: makePack({}),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate(), // no permissions block → deny-all
      reevaluateOriginalRule: reeval,
    });
    expect(result.corrected).toBe(false);
    expect(result.fallthrough?.kind).toBe('capability_denied');
    expect(invocations.count).toBe(0);
    expect(reeval).not.toHaveBeenCalled();
  });

  it('LOCKED ORDER: gate.check BEFORE skill invocation BEFORE re-eval', async () => {
    const order: string[] = [];
    const gate = makeGate({ subagent_call: { targets: ['auto-format-skill'], deny: [] } });
    const realCheck = gate.check.bind(gate);
    gate.check = async (req) => {
      order.push(`gate(${req.capability}:${req.target})`);
      return realCheck(req);
    };

    const registry = new FunctionRegistry();
    registry.register({
      name: 'corrective_op',
      argSchema: z.object({}).strict(),
      execute: async () => {
        order.push('skill_invocation');
        return ok({ ran: true });
      },
    });
    registry.register({
      name: 'verdict',
      argSchema: VerdictArgs,
      execute: async ({ level, message }) => ok({ level, message }),
    });

    await runAutoCorrect({
      pack: makePack({}),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: gate,
      reevaluateOriginalRule: () => {
        order.push('reeval');
        return Promise.resolve(passResult);
      },
    });
    expect(order).toEqual(['gate(subagent_call:auto-format-skill)', 'skill_invocation', 'reeval']);
  });

  it('pack-local subagent_call deny rejects target', async () => {
    const { registry, invocations } = makeRegistry();
    const result = await runAutoCorrect({
      pack: makePack({}),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({
        subagent_call: { targets: ['*'], deny: ['auto-format-skill'] },
      }),
      reevaluateOriginalRule: () => Promise.resolve(passResult),
    });
    expect(result.corrected).toBe(false);
    expect(result.fallthrough?.kind).toBe('capability_denied');
    expect(invocations.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Missing / broken corrective skill

describe('runAutoCorrect — missing / broken corrective skill', () => {
  it('corrective skill not found in pack → fall-through (no invocation)', async () => {
    const { registry, invocations } = makeRegistry();
    const result = await runAutoCorrect({
      pack: makePack({ correctiveSkillName: 'other-skill' }),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({ subagent_call: { targets: ['*'], deny: [] } }),
      reevaluateOriginalRule: () => Promise.resolve(passResult),
    });
    expect(result.fallthrough?.kind).toBe('corrective_skill_missing');
    expect(invocations.count).toBe(0);
  });

  it('corrective skill exists but has no track_check process steps', async () => {
    const { registry, invocations } = makeRegistry();
    const result = await runAutoCorrect({
      pack: makePack({ noProcessSteps: true }),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({ subagent_call: { targets: ['*'], deny: [] } }),
      reevaluateOriginalRule: () => Promise.resolve(passResult),
    });
    expect(result.fallthrough?.kind).toBe('corrective_skill_missing');
    expect(invocations.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LOOP CAP — 1 attempt max

describe('runAutoCorrect — LOOP CAP: 1 attempt maximum', () => {
  it('corrective skill produces drift → fall-through, NO recursion, NO re-eval', async () => {
    const { registry } = makeRegistry();
    const reeval = vi.fn(() => Promise.resolve(passResult));
    const result = await runAutoCorrect({
      pack: makePack({ correctiveSkillDrifts: true }),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({ subagent_call: { targets: ['*'], deny: [] } }),
      reevaluateOriginalRule: reeval,
    });
    expect(result.fallthrough?.kind).toBe('corrective_skill_drift');
    expect(result.fallthrough?.reason).toMatch(/itself produced drift/);
    expect(reeval).not.toHaveBeenCalled();
  });

  it('re-eval still drifts → fall-through, NO second auto_correct attempt', async () => {
    const { registry, invocations } = makeRegistry();
    const persistent: RuleResult = {
      kind: 'verdict',
      verdict: { level: 'block', message: 'still broken', ruleId: 'format-violation' },
    };
    const reeval = vi.fn(() => Promise.resolve(persistent));
    const result = await runAutoCorrect({
      pack: makePack({}),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({ subagent_call: { targets: ['*'], deny: [] } }),
      reevaluateOriginalRule: reeval,
    });
    expect(result.fallthrough?.kind).toBe('reeval_persistent_drift');
    expect(invocations.count).toBe(1);
    expect(reeval).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Error propagation

describe('runAutoCorrect — error propagation', () => {
  it('corrective primitive throws → corrective_skill_error', async () => {
    const { registry } = makeRegistry({ throwOnRun: true });
    const result = await runAutoCorrect({
      pack: makePack({}),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({ subagent_call: { targets: ['*'], deny: [] } }),
      reevaluateOriginalRule: () => Promise.resolve(passResult),
    });
    expect(result.fallthrough?.kind).toBe('corrective_skill_error');
  });

  it('re-eval thunk throws → reeval_error', async () => {
    const { registry } = makeRegistry();
    const result = await runAutoCorrect({
      pack: makePack({}),
      correctiveSkill: 'auto-format-skill',
      verdict: baseVerdict,
      evalCtx: baseCtx,
      registry,
      capabilityGate: makeGate({ subagent_call: { targets: ['*'], deny: [] } }),
      reevaluateOriginalRule: () => Promise.reject(new Error('reeval failed')),
    });
    expect(result.fallthrough?.kind).toBe('reeval_error');
    expect(result.fallthrough?.reason).toContain('reeval failed');
  });
});

/**
 * Tests for the `check_destination` primitive.
 *
 * Strategy: stub `llm_classify` directly in the registry (no real model
 * dispatch). The primitive's contract is "call `llm_classify` with the goal
 * + recent actions + allowed_labels, then map the label to a pass/block
 * verdict". The stub captures the args so we can assert the prompt shape
 * and the label set, then returns a fixture label.
 *
 * Coverage (≥ 4 cases per acceptance criteria, plus error + prompt-shape):
 *   1. ON_GOAL → pass verdict with empty message.
 *   2. DRIFTING → block verdict with goal name in the message.
 *   3. UNCERTAIN → pass (conservative, never block on classifier confusion).
 *   4. Empty `recent_actions` → primitive still calls the classifier with
 *      a valid prompt (no crash on `.map` over an empty array).
 *   5. `llm_classify` returns an `err` → propagates as `err` (don't swallow
 *      config errors like unknown model alias).
 *   6. Default model alias is `'reasoning'` when not passed in args.
 *   7. Prompt includes the goal and the action lines numbered from 1.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { err, ok } from '../runtime/result.js';

import { registerDestinationCheckFunction } from './destination_check.js';
import { type EvalCtx, type FunctionDef, FunctionRegistry } from './registry.js';
import type { Event } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface ClassifyCapture {
  model: string;
  prompt: string;
  allowed_labels: string[];
}

interface ClassifyArgs {
  model: string;
  prompt: string;
  allowed_labels: string[];
}

function stubClassify(
  registry: FunctionRegistry,
  capture: ClassifyCapture[],
  returnValue: { ok: true; value: string } | { ok: false },
): void {
  const def: FunctionDef<ClassifyArgs, string> = {
    name: 'llm_classify',
    argSchema: z.object({
      model: z.string().min(1),
      prompt: z.string().min(1),
      allowed_labels: z.array(z.string().min(1)).min(1),
    }),
    execute: (args) => {
      capture.push({ ...args });
      if (returnValue.ok) return Promise.resolve(ok(returnValue.value));
      return Promise.resolve(
        err({ kind: 'arg_invalid' as const, message: 'unknown model alias "reasoning"' }),
      );
    },
  };
  registry.register(def);
}

function createCtx(): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map(),
    sessionId: 'test-session',
    packId: 'test-pack',
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('check_destination', () => {
  it("returns a pass verdict when the classifier says 'ON_GOAL'", async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: true, value: 'ON_GOAL' });
    registerDestinationCheckFunction(reg);

    const result = await reg.call(
      'check_destination',
      {
        goal: 'Build the form component',
        recent_actions: ['Edit form.tsx', 'Run tests'],
      },
      createCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ level: 'pass', message: '' });
  });

  it("returns a block verdict naming the goal when the classifier says 'DRIFTING'", async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: true, value: 'DRIFTING' });
    registerDestinationCheckFunction(reg);

    const result = await reg.call(
      'check_destination',
      {
        goal: 'Build the form component',
        recent_actions: ['Edit billing.tsx', 'Read invoices.ts'],
      },
      createCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const value = result.value as { level: string; message: string };
    expect(value.level).toBe('block');
    expect(value.message).toContain('Build the form component');
    expect(value.message.toLowerCase()).toContain('drift');
  });

  it("returns a pass verdict when the classifier says 'UNCERTAIN' (conservative)", async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: true, value: 'UNCERTAIN' });
    registerDestinationCheckFunction(reg);

    const result = await reg.call(
      'check_destination',
      { goal: 'Ship the release', recent_actions: ['Did something ambiguous'] },
      createCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toEqual({ level: 'pass', message: '' });
  });

  it('handles empty `recent_actions` without crashing and still calls the classifier', async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: true, value: 'ON_GOAL' });
    registerDestinationCheckFunction(reg);

    const result = await reg.call(
      'check_destination',
      { goal: 'Bootstrap a new project', recent_actions: [] },
      createCtx(),
    );

    expect(result.ok).toBe(true);
    expect(capture).toHaveLength(1);
    expect(capture[0]?.prompt).toContain('Pack goal: Bootstrap a new project');
    expect(capture[0]?.prompt).toContain('(no actions recorded yet)');
  });

  it('propagates `err` from llm_classify (e.g. unknown model alias)', async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: false });
    registerDestinationCheckFunction(reg);

    const result = await reg.call(
      'check_destination',
      { goal: 'g', recent_actions: ['a'] },
      createCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('arg_invalid');
  });

  it("defaults the model alias to 'reasoning' when not provided in args", async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: true, value: 'ON_GOAL' });
    registerDestinationCheckFunction(reg);

    await reg.call('check_destination', { goal: 'g', recent_actions: ['a'] }, createCtx());

    expect(capture).toHaveLength(1);
    expect(capture[0]?.model).toBe('reasoning');
    expect(capture[0]?.allowed_labels).toEqual(['ON_GOAL', 'DRIFTING', 'UNCERTAIN']);
  });

  it('honors a caller-provided model alias override', async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: true, value: 'ON_GOAL' });
    registerDestinationCheckFunction(reg);

    await reg.call(
      'check_destination',
      { goal: 'g', recent_actions: ['a'], model: 'fast_classifier' },
      createCtx(),
    );

    expect(capture[0]?.model).toBe('fast_classifier');
  });

  it('builds a numbered prompt with the goal and each recent action', async () => {
    const reg = new FunctionRegistry();
    const capture: ClassifyCapture[] = [];
    stubClassify(reg, capture, { ok: true, value: 'ON_GOAL' });
    registerDestinationCheckFunction(reg);

    await reg.call(
      'check_destination',
      {
        goal: 'Render the dashboard',
        recent_actions: ['Edit dashboard.tsx', 'Edit Sidebar.tsx', 'Run vitest'],
      },
      createCtx(),
    );

    const prompt = capture[0]?.prompt ?? '';
    expect(prompt).toContain('Pack goal: Render the dashboard');
    expect(prompt).toContain('1. Edit dashboard.tsx');
    expect(prompt).toContain('2. Edit Sidebar.tsx');
    expect(prompt).toContain('3. Run vitest');
    expect(prompt).toContain('ON_GOAL or DRIFTING');
  });

  it('returns `not_found` err when llm_classify is not registered', async () => {
    const reg = new FunctionRegistry();
    registerDestinationCheckFunction(reg);

    const result = await reg.call(
      'check_destination',
      { goal: 'g', recent_actions: ['a'] },
      createCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('not_found');
  });
});

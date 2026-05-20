/**
 * Tests for `routeSkills` — model-aliased skill router (Phase 3 Task 3.4).
 *
 * Strategy:
 *   - Instead of spawning a real CLI through `llm_classify`'s strategy
 *     dispatcher, we register a *stub* `llm_classify` directly on a
 *     fresh `FunctionRegistry`. The router only knows the function by
 *     name; substituting the implementation gives us deterministic
 *     control over what the "classifier" returns without touching
 *     `OPENSQUID_MODELS_CONFIG_INLINE` or `process.execPath`.
 *   - The stub asserts on its received `model` arg so we can prove the
 *     `fast_classifier` alias is what the router actually requests
 *     (acceptance criterion: "No model name in code").
 *   - 5 cases:
 *       1. Stub returns "git,docs" with candidates [git, docs, infra]
 *          → only [git, docs] returned.
 *       2. Stub returns "NONE" → all candidates (fallback).
 *       3. Stub returns "UNCERTAIN" → all candidates (fallback).
 *       4. Empty candidates → [] (early return; classifier never invoked).
 *       5. Classifier returns `err` → all candidates (fallback).
 */

import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { type EvalCtx, FunctionRegistry } from '../functions/registry.js';
import { err, ok } from './result.js';

import { routeSkills } from './skill_router.js';
import type { Skill } from './types.js';
import type { Event } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function makeSkill(name: string, prose: string): Skill {
  return {
    name,
    prose,
    load: 'lazy',
    when_to_load: [],
    unloads_when: [],
    triggers: [{ kind: 'tool_call' }],
    rules: [],
  };
}

function createTestCtx(): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'session-router-test',
    packId: 'test-pack',
  };
}

/**
 * Build a fresh `FunctionRegistry` with a stub `llm_classify` that:
 *   - validates args with the same Zod shape the real primitive uses
 *     (model + prompt + allowed_labels);
 *   - calls back `onCall` with the received args so the test can
 *     assert on the prompt and the alias;
 *   - resolves with the `respondWith` value (either an ok-string or
 *     a thrown-style err).
 */
function registryWithStubClassifier(
  respondWith: { kind: 'ok'; value: string } | { kind: 'err'; message: string },
  onCall?: (args: { model: string; prompt: string; allowed_labels: string[] }) => void,
): FunctionRegistry {
  const reg = new FunctionRegistry();
  reg.register({
    name: 'llm_classify',
    argSchema: z.object({
      model: z.string(),
      prompt: z.string(),
      allowed_labels: z.array(z.string()),
      timeout_ms: z.number().optional(),
    }),
    execute: (args) => {
      onCall?.(args);
      if (respondWith.kind === 'err') {
        return Promise.resolve(err({ kind: 'runtime', message: respondWith.message }));
      }
      return Promise.resolve(ok(respondWith.value));
    },
  });
  return reg;
}

// ---------------------------------------------------------------------------
// 1. Classifier returns "git,docs" → only those two candidates kept.
// ---------------------------------------------------------------------------

describe('routeSkills — comma-list filter', () => {
  it('returns only the candidates the classifier named', async () => {
    const skills = [
      makeSkill('git', 'git operations'),
      makeSkill('docs', 'documentation writing'),
      makeSkill('infra', 'infra ops'),
    ];
    const onCall = vi.fn();
    const reg = registryWithStubClassifier({ kind: 'ok', value: 'git,docs' }, onCall);

    const result = await routeSkills('commit and push docs', skills, reg, createTestCtx());

    expect(result.map((s) => s.name)).toEqual(['git', 'docs']);

    // Acceptance criterion: alias used must be `fast_classifier`, never
    // a vendor model id.
    expect(onCall).toHaveBeenCalledTimes(1);
    const callArgs = onCall.mock.calls[0]![0] as {
      model: string;
      prompt: string;
      allowed_labels: string[];
    };
    expect(callArgs.model).toBe('fast_classifier');
    // Prompt sanity: subject up top + skill list + strict-output suffix.
    expect(callArgs.prompt).toContain('Task: commit and push docs');
    expect(callArgs.prompt).toContain('git: git operations');
    expect(callArgs.prompt).toContain('comma-separated skill names, or NONE');
    // Allowed labels = candidate names + NONE.
    expect(callArgs.allowed_labels).toEqual(['git', 'docs', 'infra', 'NONE']);
  });

  it('trims whitespace around comma tokens', async () => {
    const skills = [makeSkill('git', 'g'), makeSkill('docs', 'd')];
    const reg = registryWithStubClassifier({ kind: 'ok', value: ' git , docs ' });
    const result = await routeSkills('subject', skills, reg, createTestCtx());
    expect(result.map((s) => s.name).sort()).toEqual(['docs', 'git']);
  });

  it('drops tokens that do not match any candidate', async () => {
    const skills = [makeSkill('git', 'g'), makeSkill('docs', 'd')];
    const reg = registryWithStubClassifier({ kind: 'ok', value: 'git,hallucinated' });
    const result = await routeSkills('subject', skills, reg, createTestCtx());
    expect(result.map((s) => s.name)).toEqual(['git']);
  });
});

// ---------------------------------------------------------------------------
// 2. NONE → fallback to all candidates.
// ---------------------------------------------------------------------------

describe('routeSkills — NONE fallback', () => {
  it('returns ALL candidates when classifier replies NONE', async () => {
    const skills = [makeSkill('git', 'g'), makeSkill('docs', 'd'), makeSkill('infra', 'i')];
    const reg = registryWithStubClassifier({ kind: 'ok', value: 'NONE' });
    const result = await routeSkills('subject', skills, reg, createTestCtx());
    expect(result).toEqual(skills);
  });
});

// ---------------------------------------------------------------------------
// 3. UNCERTAIN → fallback to all candidates.
// ---------------------------------------------------------------------------

describe('routeSkills — UNCERTAIN fallback', () => {
  it('returns ALL candidates when classifier clamps to UNCERTAIN', async () => {
    const skills = [makeSkill('git', 'g'), makeSkill('docs', 'd')];
    const reg = registryWithStubClassifier({ kind: 'ok', value: 'UNCERTAIN' });
    const result = await routeSkills('subject', skills, reg, createTestCtx());
    expect(result).toEqual(skills);
  });
});

// ---------------------------------------------------------------------------
// 4. Empty candidates → [] without invoking the classifier.
// ---------------------------------------------------------------------------

describe('routeSkills — empty candidates', () => {
  it('returns [] and does not call the classifier when candidates is empty', async () => {
    const onCall = vi.fn();
    const reg = registryWithStubClassifier({ kind: 'ok', value: 'git' }, onCall);
    const result = await routeSkills('subject', [], reg, createTestCtx());
    expect(result).toEqual([]);
    expect(onCall).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Classifier errors → fallback to all candidates.
// ---------------------------------------------------------------------------

describe('routeSkills — classifier error fallback', () => {
  it('returns ALL candidates when llm_classify returns an err', async () => {
    const skills = [makeSkill('git', 'g'), makeSkill('docs', 'd')];
    const reg = registryWithStubClassifier({ kind: 'err', message: 'unknown alias' });
    const result = await routeSkills('subject', skills, reg, createTestCtx());
    expect(result).toEqual(skills);
  });

  it('returns ALL candidates when llm_classify is missing from the registry', async () => {
    // Empty registry — call() will return `{kind:'not_found'}`, which is
    // !ok, which routeSkills treats as "fall back to all candidates".
    const skills = [makeSkill('git', 'g')];
    const reg = new FunctionRegistry();
    const result = await routeSkills('subject', skills, reg, createTestCtx());
    expect(result).toEqual(skills);
  });
});

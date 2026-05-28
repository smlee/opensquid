/**
 * Tests for verdict + action-descriptor primitives (`verdict`, `halt_task`,
 * `restart_workflow`, `set_active_task_state`).
 *
 * Per Task 1.6 acceptance criteria: ≥ 3 cases for primitives, ≥ 6 cases
 * total across this file + `drift_response.test.ts`. Coverage:
 *
 *   - `verdict` returns ok({ level, message }) via the registry.
 *   - `halt_task` returns ok({ kind: 'halt', reason }).
 *   - `restart_workflow` maps snake_case (`entry_skill`) → camelCase
 *     (`entrySkill`) — opensquid YAML-to-TS convention.
 *   - `set_active_task_state` returns ok({ kind: 'state_set', state }).
 *   - Zod rejects invalid `level` with `arg_invalid`.
 *
 * No filesystem / no LLM — these primitives are pure transforms.
 */

import { describe, expect, it } from 'vitest';

import { ok } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerVerdictFunctions } from './verdict.js';

// ---------------------------------------------------------------------------
// Scaffolding — fresh registry per test + EvalCtx with a dummy tool_call.
// The verdict primitives don't read the event, but `EvalCtx.event` is
// required by the registry signature.
// ---------------------------------------------------------------------------

function freshRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerVerdictFunctions(reg);
  return reg;
}

function createTestCtx(): EvalCtx {
  const event: Event = { kind: 'tool_call', tool: 'Bash', args: {} };
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'test-session',
    packId: 'test-pack',
  };
}

describe('verdict primitive', () => {
  it('returns ok({ level, message }) on a valid block verdict', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const result = await reg.call('verdict', { level: 'block', message: 'never amend' }, ctx);

    expect(result).toEqual(ok({ level: 'block', message: 'never amend' }));
  });

  it('accepts all four levels (pass / block / warn / surface)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    for (const level of ['pass', 'block', 'warn', 'surface'] as const) {
      const result = await reg.call('verdict', { level, message: 'm' }, ctx);
      expect(result).toEqual(ok({ level, message: 'm' }));
    }
  });

  it('returns err(arg_invalid) on an invalid level enum value', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const result = await reg.call('verdict', { level: 'WRONG', message: 'm' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('arg_invalid');
    }
  });

  // ---------------------------------------------------------------------------
  // T-ASC ASC.3 — directive-level verdict (structured next-action handoff)
  // ---------------------------------------------------------------------------

  it('accepts level: directive with next_action.skill + rationale', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();
    const result = await reg.call(
      'verdict',
      {
        level: 'directive',
        next_action: {
          skill: 'task-spec-author',
          args: { pre_research_path: '/abs/p.md' },
          rationale: 'pre-research landed — author the spec next.',
        },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = result.value as { level: string; next_action: { skill?: string } };
      expect(v.level).toBe('directive');
      expect(v.next_action.skill).toBe('task-spec-author');
    }
  });

  it('accepts level: directive with next_action.tool + rationale (XOR)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();
    const result = await reg.call(
      'verdict',
      {
        level: 'directive',
        next_action: {
          tool: 'TaskCreate',
          args: { metadata: { taskId: 'ASC.X' } },
          rationale: 'spec on disk — load tasks.',
        },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects level: directive with BOTH skill AND tool (XOR refine)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();
    const result = await reg.call(
      'verdict',
      {
        level: 'directive',
        next_action: {
          skill: 'x',
          tool: 'y',
          rationale: 'ambiguous',
        },
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('arg_invalid');
  });

  it('rejects level: directive with NEITHER skill NOR tool (XOR refine)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();
    const result = await reg.call(
      'verdict',
      { level: 'directive', next_action: { rationale: 'orphan' } },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects level: directive with missing rationale', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();
    const result = await reg.call(
      'verdict',
      { level: 'directive', next_action: { skill: 'x' } },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects level: directive carrying a stray message: field (.strict)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();
    const result = await reg.call(
      'verdict',
      {
        level: 'directive',
        next_action: { skill: 'x', rationale: 'r' },
        message: 'unexpected',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects level: pass carrying next_action (.strict)', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();
    const result = await reg.call(
      'verdict',
      { level: 'pass', message: 'm', next_action: { skill: 'x', rationale: 'r' } },
      ctx,
    );
    expect(result.ok).toBe(false);
  });
});

describe('halt_task primitive', () => {
  it('returns ok({ kind: "halt", reason })', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const result = await reg.call('halt_task', { reason: 'workflow drift' }, ctx);

    expect(result).toEqual(ok({ kind: 'halt', reason: 'workflow drift' }));
  });
});

describe('restart_workflow primitive', () => {
  it('maps snake_case entry_skill → camelCase entrySkill', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const result = await reg.call('restart_workflow', { entry_skill: 'pre_research' }, ctx);

    expect(result).toEqual(ok({ kind: 'restart', entrySkill: 'pre_research' }));
  });
});

describe('set_active_task_state primitive', () => {
  it('returns ok({ kind: "state_set", state })', async () => {
    const reg = freshRegistry();
    const ctx = createTestCtx();

    const result = await reg.call('set_active_task_state', { state: 'auditing' }, ctx);

    expect(result).toEqual(ok({ kind: 'state_set', state: 'auditing' }));
  });
});

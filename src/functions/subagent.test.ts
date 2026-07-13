/**
 * Tests for the `spawn_subagent` primitive (Task 6.2).
 *
 * Strategy: inject a stub `SubagentSdk` via `registerSubagentFunction(reg,
 * { sdk })`. The lazy dynamic import path (production default) requires the
 * real `@anthropic-ai/claude-agent-sdk` package + network auth — out of
 * scope for unit tests. The stub satisfies the same `SubagentSdk` interface.
 *
 * Coverage (≥ 3 per acceptance criteria):
 *   1. Stubbed SDK returns text + drifts → ok({ stdout, drifts }) — drifts
 *      passed through.
 *   2. SDK throws → err({ kind: 'runtime' }) — error wrapped, not surfaced
 *      raw.
 *   3. SDK returns no drifts → ok({ stdout, drifts: [] }) — undefined drifts
 *      coerced to empty array.
 *   4. Registration: `registerSubagentFunction` adds `spawn_subagent` to
 *      the registry (positive `has`).
 *   5. `context` shape: `project` + `profession` accepted; extra fields
 *      rejected by Zod strict schema.
 *   6. Argument validation: empty `model` / `prompt` rejected.
 */

import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionLogFile } from '../runtime/paths.js';

import {
  registerSubagentFunction,
  type SubagentDrift,
  type SubagentSdk,
  type SubagentSdkRunResult,
} from './subagent.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';
import type { Event } from '../runtime/types.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function createCtx(sessionId = 'parent-session', packModels?: EvalCtx['packModels']): EvalCtx {
  const event: Event = { kind: 'stop', assistantText: '' };
  return {
    event,
    bindings: new Map(),
    sessionId,
    packId: 'team-pack',
    ...(packModels === undefined ? {} : { packModels }),
  };
}

// ---------------------------------------------------------------------------
// Temp-dir fixture for drift roll-up tests (Task 6.4).
//
// Drift roll-up writes to `OPENSQUID_HOME/sessions/<id>/state/drift-catalog.jsonl`.
// Each test gets its own temp home so writes are isolated.
// ---------------------------------------------------------------------------

let tempHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = join(tmpdir(), `opensquid-subagent-${Math.random().toString(36).slice(2, 10)}`);
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

async function readParentCatalogLines(parentSessionId: string): Promise<Record<string, unknown>[]> {
  const path = sessionLogFile(parentSessionId, 'drift-catalog');
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface SpawnCapture {
  model: string;
  prompt: string;
  context: Record<string, unknown>;
  packModels?: EvalCtx['packModels'];
}

function makeStubSdk(
  capture: SpawnCapture[],
  outcome: { kind: 'ok'; result: SubagentSdkRunResult } | { kind: 'throw'; error: unknown },
): SubagentSdk {
  return {
    runAgent: ({ model, prompt, context, packModels }) => {
      capture.push({ model, prompt, context, packModels });
      if (outcome.kind === 'throw') {
        const e = outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        return Promise.reject(e);
      }
      return Promise.resolve(outcome.result);
    },
  };
}

// ---------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------

describe('registerSubagentFunction', () => {
  it('registers `spawn_subagent` on the registry', () => {
    const reg = new FunctionRegistry();
    registerSubagentFunction(reg);
    expect(reg.has('spawn_subagent')).toBe(true);
  });

  it('returns ok({ stdout, drifts }) when stubbed SDK succeeds with drifts', async () => {
    const reg = new FunctionRegistry();
    const capture: SpawnCapture[] = [];
    const fixtureDrifts: SubagentDrift[] = [
      {
        timestamp: '2026-05-19T10:00:00Z',
        pack: 'profession/code-reviewer',
        ruleId: 'r1',
        level: 'block',
        message: 'drifted from goal',
      },
    ];
    const sdk = makeStubSdk(capture, {
      kind: 'ok',
      result: { text: 'review done', drifts: fixtureDrifts },
    });
    registerSubagentFunction(reg, { sdk });

    const result = await reg.call(
      'spawn_subagent',
      {
        model: 'reasoning',
        prompt: 'Review the PR',
        context: { project: 'opensquid', profession: 'code-reviewer' },
      },
      createCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const value = result.value as { stdout: string; drifts: SubagentDrift[] };
    expect(value.stdout).toBe('review done');
    expect(value.drifts).toHaveLength(1);
    expect(value.drifts[0]?.message).toBe('drifted from goal');
    // SDK called with the right inputs.
    expect(capture).toHaveLength(1);
    expect(capture[0]?.model).toBe('reasoning');
    expect(capture[0]?.context).toEqual({ project: 'opensquid', profession: 'code-reviewer' });
  });

  it('returns ok with drifts: [] when SDK omits the drifts field', async () => {
    const reg = new FunctionRegistry();
    const capture: SpawnCapture[] = [];
    const sdk = makeStubSdk(capture, { kind: 'ok', result: { text: 'no drifts' } });
    registerSubagentFunction(reg, { sdk });

    const result = await reg.call(
      'spawn_subagent',
      { model: 'reasoning', prompt: 'p' },
      createCtx(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const value = result.value as { stdout: string; drifts: SubagentDrift[] };
    expect(value.stdout).toBe('no drifts');
    expect(value.drifts).toEqual([]);
  });

  it('returns err({ kind: "runtime" }) when SDK.runAgent throws', async () => {
    const reg = new FunctionRegistry();
    const capture: SpawnCapture[] = [];
    const sdk = makeStubSdk(capture, { kind: 'throw', error: new Error('network down') });
    registerSubagentFunction(reg, { sdk });

    const result = await reg.call(
      'spawn_subagent',
      { model: 'reasoning', prompt: 'p' },
      createCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('runtime');
    expect(String(result.error.message)).toContain('network down');
  });

  it('passes context: {} to SDK when caller omits context and threads ctx.packModels', async () => {
    const reg = new FunctionRegistry();
    const capture: SpawnCapture[] = [];
    const sdk = makeStubSdk(capture, { kind: 'ok', result: { text: 'ok' } });
    registerSubagentFunction(reg, { sdk });

    await reg.call(
      'spawn_subagent',
      { model: 'reasoning', prompt: 'p' },
      createCtx('parent-session', {
        reasoning: {
          mode: 'subscription',
          model: 'claude-sonnet',
          description: '',
          args: [],
        },
      }),
    );

    expect(capture[0]?.context).toEqual({});
    expect(capture[0]?.packModels).toEqual({
      reasoning: { mode: 'subscription', model: 'claude-sonnet', description: '', args: [] },
    });
  });

  it('rejects context with unknown fields via Zod strict (arg_invalid)', async () => {
    const reg = new FunctionRegistry();
    const sdk = makeStubSdk([], { kind: 'ok', result: { text: 'never' } });
    registerSubagentFunction(reg, { sdk });

    const result = await reg.call(
      'spawn_subagent',
      {
        model: 'reasoning',
        prompt: 'p',
        context: { project: 'p', profession: 'x', secrets: 'LEAK' },
      },
      createCtx(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('arg_invalid');
  });

  it('rejects empty model or prompt', async () => {
    const reg = new FunctionRegistry();
    const sdk = makeStubSdk([], { kind: 'ok', result: { text: 'never' } });
    registerSubagentFunction(reg, { sdk });

    const result = await reg.call('spawn_subagent', { model: '', prompt: 'p' }, createCtx());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('arg_invalid');
  });

  // -------------------------------------------------------------------------
  // Task 6.4 — drift roll-up to the parent's session-level catalog.
  // -------------------------------------------------------------------------

  it('writes subagent drifts to the parent session catalog with provenance', async () => {
    const reg = new FunctionRegistry();
    const sdk = makeStubSdk([], {
      kind: 'ok',
      result: {
        text: 'review done',
        drifts: [
          {
            timestamp: '2026-05-19T10:00:00Z',
            pack: 'profession/code-reviewer',
            ruleId: 'r1',
            level: 'block',
            message: 'drifted from goal',
          },
        ],
      },
    });
    registerSubagentFunction(reg, { sdk, subagentIdFactory: () => 'subagent-fixed' });

    const result = await reg.call(
      'spawn_subagent',
      {
        model: 'reasoning',
        prompt: 'Review the PR',
        context: { project: 'opensquid', profession: 'code-reviewer' },
      },
      createCtx('parent-session-rollup'),
    );

    expect(result.ok).toBe(true);
    const lines = await readParentCatalogLines('parent-session-rollup');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      timestamp: '2026-05-19T10:00:00Z',
      pack: 'profession/code-reviewer',
      ruleId: 'r1',
      level: 'block',
      message: 'drifted from goal',
      subagentId: 'subagent-fixed',
      professionPack: 'code-reviewer',
    });
  });

  it('records two independent subagent drifts with their own provenance', async () => {
    // First spawn: code-reviewer.
    const reg1 = new FunctionRegistry();
    const sdk1 = makeStubSdk([], {
      kind: 'ok',
      result: {
        text: 'a',
        drifts: [
          {
            timestamp: '2026-05-19T10:00:00Z',
            ruleId: 'r-a',
            level: 'warn',
            message: 'from reviewer',
          },
        ],
      },
    });
    registerSubagentFunction(reg1, { sdk: sdk1, subagentIdFactory: () => 'subagent-A' });
    const r1 = await reg1.call(
      'spawn_subagent',
      {
        model: 'reasoning',
        prompt: 'p',
        context: { profession: 'code-reviewer' },
      },
      createCtx('parent-multi'),
    );
    expect(r1.ok).toBe(true);

    // Second spawn under same parent session: docs-reviewer.
    const reg2 = new FunctionRegistry();
    const sdk2 = makeStubSdk([], {
      kind: 'ok',
      result: {
        text: 'b',
        drifts: [
          {
            timestamp: '2026-05-19T11:00:00Z',
            ruleId: 'r-b',
            level: 'block',
            message: 'from docs',
          },
        ],
      },
    });
    registerSubagentFunction(reg2, { sdk: sdk2, subagentIdFactory: () => 'subagent-B' });
    const r2 = await reg2.call(
      'spawn_subagent',
      {
        model: 'reasoning',
        prompt: 'p',
        context: { profession: 'docs-reviewer' },
      },
      createCtx('parent-multi'),
    );
    expect(r2.ok).toBe(true);

    const lines = await readParentCatalogLines('parent-multi');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      subagentId: 'subagent-A',
      professionPack: 'code-reviewer',
      message: 'from reviewer',
    });
    expect(lines[1]).toMatchObject({
      subagentId: 'subagent-B',
      professionPack: 'docs-reviewer',
      message: 'from docs',
    });
  });

  it('does not create a parent catalog file when SDK returns zero drifts', async () => {
    const reg = new FunctionRegistry();
    const sdk = makeStubSdk([], { kind: 'ok', result: { text: 'clean', drifts: [] } });
    registerSubagentFunction(reg, { sdk });

    const result = await reg.call(
      'spawn_subagent',
      { model: 'reasoning', prompt: 'p', context: { profession: 'x' } },
      createCtx('parent-empty'),
    );
    expect(result.ok).toBe(true);

    // No file should exist — readFile throws ENOENT.
    await expect(readParentCatalogLines('parent-empty')).rejects.toThrow();
  });

  it('uses <unspecified> as professionPack when context.profession is absent', async () => {
    const reg = new FunctionRegistry();
    const sdk = makeStubSdk([], {
      kind: 'ok',
      result: {
        text: 'a',
        drifts: [
          {
            timestamp: '2026-05-19T10:00:00Z',
            ruleId: 'r1',
            level: 'warn',
            message: 'no profession',
          },
        ],
      },
    });
    registerSubagentFunction(reg, { sdk, subagentIdFactory: () => 'subagent-noprof' });
    const r = await reg.call(
      'spawn_subagent',
      { model: 'reasoning', prompt: 'p' },
      createCtx('parent-noprof'),
    );
    expect(r.ok).toBe(true);

    const lines = await readParentCatalogLines('parent-noprof');
    expect(lines[0]).toMatchObject({
      subagentId: 'subagent-noprof',
      professionPack: '<unspecified>',
    });
  });

  it('the real SDK query adapter omits options.model for a subscription alias without a concrete model', async () => {
    vi.resetModules();
    const seen: { prompt: string; options?: { cwd?: string; model?: string } }[] = [];
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (input: { prompt: string; options?: { cwd?: string; model?: string } }) => {
        seen.push(input);
        return {
          async *[Symbol.asyncIterator]() {
            yield await Promise.resolve({ type: 'result', result: 'done' });
          },
          close: () => undefined,
        };
      },
    }));

    const reg = new FunctionRegistry();
    const { registerSubagentFunction: registerFresh } = await import('./subagent.js');
    registerFresh(reg);
    const result = await reg.call(
      'spawn_subagent',
      { model: 'reasoning', prompt: 'p', context: { project: '/repo' } },
      createCtx('parent-real-sdk', {
        reasoning: { mode: 'subscription', description: '', args: [] },
      }),
    );

    expect(result.ok).toBe(true);
    expect(seen[0]?.options?.cwd).toBe('/repo');
    expect(Object.prototype.hasOwnProperty.call(seen[0]?.options ?? {}, 'model')).toBe(false);
    vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  });

  it('the real SDK query adapter aggregates result errors and returns a runtime failure', async () => {
    vi.resetModules();
    const seen: { prompt: string; options?: { cwd?: string; model?: string } }[] = [];
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (input: { prompt: string; options?: { cwd?: string; model?: string } }) => {
        seen.push(input);
        return {
          async *[Symbol.asyncIterator]() {
            yield await Promise.resolve({
              type: 'result',
              is_error: true,
              errors: ['first failure', 'second failure'],
            });
          },
          close: () => undefined,
        };
      },
    }));

    const reg = new FunctionRegistry();
    const { registerSubagentFunction: registerFresh } = await import('./subagent.js');
    registerFresh(reg);
    const result = await reg.call(
      'spawn_subagent',
      { model: 'reasoning', prompt: 'p', context: { project: '/repo' } },
      createCtx('parent-real-sdk-errors', {
        reasoning: { mode: 'subscription', model: 'claude-sonnet', description: '', args: [] },
      }),
    );

    expect(seen[0]?.options?.model).toBe('claude-sonnet');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('runtime');
    expect(result.error.message).toContain('first failure; second failure');
    vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  });
});

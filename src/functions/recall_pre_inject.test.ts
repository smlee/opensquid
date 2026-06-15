/**
 * Tests for the `recall_pre_inject` primitive (G.4).
 *
 * Covers every fixture listed in the task spec's "Test fixtures" block:
 *
 *   - empty prompt → no_verdict (no recall call made)
 *   - short prompt below `min_prompt_chars` → no_verdict (no recall call)
 *   - non-prompt_submit event → no_verdict (defensive guard)
 *   - 3 hits above min_score → inject_context with all 3 formatted
 *   - 0 hits above min_score → no_verdict
 *   - 8 hits with token budget exceeded at hit 4 → keeps 3 + truncated=true
 *   - k:20 + backend returns 5 → returns 5 (no padding)
 *   - invalid k (50 > max 20) → Zod rejects at registry boundary
 *   - backend.recall throws → runtime error result
 *
 * The backend is a hand-rolled stub implementing `RagBackend`. We don't
 * exercise the real libsql/Ollama backend — that path is covered by
 * `rag.test.ts`. Here we focus on the filter / token-budget / formatter
 * logic that's specific to `recall_pre_inject`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagBackend, RecallHit } from '../rag/types.js';
import { writeActiveTask } from '../runtime/session_state.js';
import type { Event } from '../runtime/types.js';

import { type EvalCtx, FunctionRegistry } from './registry.js';
import { registerRecallPreInjectFunction } from './recall_pre_inject.js';

// Fix the recall scope so behavior is deterministic regardless of the test env's project context
// (a null namespace prepends the fail-loud notice → would change the empty-result path; broke CI).
vi.mock('../rag/scope.js', () => ({
  resolveRecallScope: () => Promise.resolve({ namespace: 'test-ns' }),
  NULL_SCOPE_NOTICE: 'NULL_SCOPE_NOTICE',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHit(score: number, content: string, source: RecallHit['source'] = 'fused'): RecallHit {
  return {
    lesson: {
      id: `lesson-${score.toFixed(3)}`,
      content,
      tags: [],
      source: 'test',
      author: 'agent',
      createdAt: '2026-05-24T00:00:00.000Z',
    },
    score,
    source,
  };
}

function makeBackend(recallFn: RagBackend['recall']): RagBackend {
  return {
    init: () => Promise.resolve(),
    embed: () => Promise.resolve(null),
    recall: recallFn,
    storeLesson: () => Promise.resolve(),
    deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
  };
}

function makeCtx(event: Event): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 'test-session',
    packId: 'test-pack',
  };
}

const promptEvent = (prompt: string): Event => ({ kind: 'prompt_submit', prompt });

function buildRegistry(backend: RagBackend): FunctionRegistry {
  const r = new FunctionRegistry();
  registerRecallPreInjectFunction(r, backend);
  return r;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recall_pre_inject', () => {
  it('returns null (no_verdict equivalent) on an empty prompt without calling recall', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([]);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call('recall_pre_inject', {}, makeCtx(promptEvent('')));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it('returns null on a prompt shorter than min_prompt_chars without calling recall', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([]);
    const registry = buildRegistry(makeBackend(recall));
    // Default min_prompt_chars = 20; "yes" is 3 chars.
    const result = await registry.call('recall_pre_inject', {}, makeCtx(promptEvent('yes')));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it('returns null on a harness control-message (task-notification) without calling recall (wg-4f91e0b5cb8c)', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([]);
    const registry = buildRegistry(makeBackend(recall));
    const markup =
      '<task-notification>\n<task-id>bw15z8xxr</task-id>\n<status>completed</status>\n</task-notification>';
    const result = await registry.call('recall_pre_inject', {}, makeCtx(promptEvent(markup)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it('skips a control-message even with leading whitespace (trimStart)', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([]);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      {},
      makeCtx(promptEvent('\n  <task-notification><task-id>x</task-id></task-notification>')),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it('returns null on a non-prompt_submit event (defensive guard)', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([]);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      {},
      makeCtx({ kind: 'tool_call', tool: 'Bash', args: {} }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBeNull();
    expect(recall).not.toHaveBeenCalled();
  });

  it('returns inject_context with all 3 hits when 3 hits are above min_score', async () => {
    const hits = [
      makeHit(0.9, 'hit one body'),
      makeHit(0.7, 'hit two body'),
      makeHit(0.5, 'hit three body'),
    ];
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue(hits);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      {},
      makeCtx(promptEvent('please fix the bug in the parser')),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const value = result.value as { kind: string; content: string };
    expect(value.kind).toBe('inject_context');
    expect(value.content).toContain('top 3 memories');
    expect(value.content).toContain('hit one body');
    expect(value.content).toContain('hit two body');
    expect(value.content).toContain('hit three body');
    expect(value.content).toContain('please fix the bug in the parser');
    expect(value.content).toContain('[end opensquid recall]');
    // No truncation marker because all hits fit.
    expect(value.content).not.toContain('truncated by token budget');
  });

  it('returns null when 0 hits clear min_score (all below threshold)', async () => {
    const hits = [makeHit(0.2, 'noise'), makeHit(0.3, 'more noise')];
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue(hits);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      {},
      makeCtx(promptEvent('please fix the bug in the parser')),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toBeNull();
  });

  it('truncates at whole-hit granularity when token budget exceeded (keeps 3, marks truncated)', async () => {
    // Each hit body ≈ 4000 chars → ~1000 tokens per hit at 4 chars/token.
    // max_tokens: 3500 → budget allows 3 hits (3000 tokens), drops the 4th.
    const big = 'x'.repeat(4000);
    const hits = Array.from({ length: 8 }, (_, i) => makeHit(0.9 - i * 0.05, big));
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue(hits);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      { max_tokens: 3500 },
      makeCtx(promptEvent('please fix the bug in the parser')),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const value = result.value as { kind: string; content: string };
    expect(value.kind).toBe('inject_context');
    expect(value.content).toContain('top 3 memories');
    expect(value.content).toContain('truncated by token budget');
    // Body should appear exactly 3 times (one per kept hit).
    const matches = value.content.split(big).length - 1;
    expect(matches).toBe(3);
  });

  it('returns all hits without padding when k:20 but backend returns 5', async () => {
    const hits = Array.from({ length: 5 }, (_, i) => makeHit(0.9 - i * 0.05, `body ${String(i)}`));
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue(hits);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      { k: 20 },
      makeCtx(promptEvent('please fix the bug in the parser')),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const value = result.value as { kind: string; content: string };
    expect(value.kind).toBe('inject_context');
    expect(value.content).toContain('top 5 memories');
    // Backend received the full k=20 ask; padding is the backend's job (it doesn't pad).
    expect(recall).toHaveBeenCalledWith(expect.any(String), 20, expect.anything());
  });

  it('Zod rejects k:50 (above max 20) at registry boundary with arg_invalid', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([]);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      { k: 50 },
      makeCtx(promptEvent('please fix the bug in the parser')),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('arg_invalid');
    expect(recall).not.toHaveBeenCalled();
  });

  it('Zod rejects unknown args (strict()) so YAML typos surface', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([]);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      { kk: 5 }, // typo: `kk` not `k`
      makeCtx(promptEvent('please fix the bug in the parser')),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('arg_invalid');
  });

  it('surfaces backend.recall throws as a runtime error result', async () => {
    const recall = vi.fn<RagBackend['recall']>().mockRejectedValue(new Error('libsql down'));
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call(
      'recall_pre_inject',
      {},
      makeCtx(promptEvent('please fix the bug in the parser')),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('runtime');
    expect(result.error.message).toContain('libsql down');
  });

  it('truncates header query to 80 chars and adds ellipsis when prompt is long', async () => {
    const longPrompt = `a`.repeat(150);
    const hits = [makeHit(0.9, 'body')];
    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue(hits);
    const registry = buildRegistry(makeBackend(recall));
    const result = await registry.call('recall_pre_inject', {}, makeCtx(promptEvent(longPrompt)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const value = result.value as { kind: string; content: string };
    expect(value.content).toContain('a'.repeat(80) + '…');
    // The full 150-char prompt should NOT appear verbatim in the header.
    expect(value.content).not.toContain('a'.repeat(150));
  });
});

// ---------------------------------------------------------------------------
// T-CTX-LOOP CTX.3 — recall query composition (active-task goal-token)
// ---------------------------------------------------------------------------

describe('recall_pre_inject — CTX.3 goal-token composition', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-recall-ctx3-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('CTX.3: when active-task is seeded, prepends `task:<taskId> goal:<subject>` to the recall query', async () => {
    const sid = 'ctx3-with-active';
    await writeActiveTask(sid, {
      id: '99',
      subject: 'CTX.3 — recall composition test goal',
      started_at: new Date().toISOString(),
      taskId: 'CTX.3',
      spec: '/abs/spec.md',
    });

    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([makeHit(0.9, 'body')]);
    const registry = buildRegistry(makeBackend(recall));
    const ctx: EvalCtx = {
      event: promptEvent('how does the loop close at session end?'),
      bindings: new Map<string, unknown>(),
      sessionId: sid,
      packId: 'test-pack',
    };
    await registry.call('recall_pre_inject', {}, ctx);

    expect(recall).toHaveBeenCalledTimes(1);
    const composedQuery = recall.mock.calls[0]?.[0] ?? '';
    expect(composedQuery).toContain('task:CTX.3');
    expect(composedQuery).toContain('goal:CTX.3 — recall composition test goal');
    expect(composedQuery).toContain('how does the loop close at session end?');
  });

  it('CTX.3: when no active-task is seeded, falls back to the raw prompt (pre-CTX.3 behavior preserved)', async () => {
    const sid = 'ctx3-no-active';
    // intentionally NO writeActiveTask call

    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([makeHit(0.9, 'body')]);
    const registry = buildRegistry(makeBackend(recall));
    const ctx: EvalCtx = {
      event: promptEvent('plain interactive prompt'),
      bindings: new Map<string, unknown>(),
      sessionId: sid,
      packId: 'test-pack',
    };
    await registry.call('recall_pre_inject', {}, ctx);

    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall.mock.calls[0]?.[0]).toBe('plain interactive prompt');
  });

  it('CTX.3: min_prompt_chars check runs against RAW prompt — goal-token cannot mask a short prompt', async () => {
    const sid = 'ctx3-short-prompt';
    await writeActiveTask(sid, {
      id: '99',
      subject: 'a very long goal-token that would otherwise satisfy min_prompt_chars',
      started_at: new Date().toISOString(),
      taskId: 'CTX.3',
    });

    const recall = vi.fn<RagBackend['recall']>().mockResolvedValue([makeHit(0.9, 'body')]);
    const registry = buildRegistry(makeBackend(recall));
    const ctx: EvalCtx = {
      event: promptEvent('hi'), // 2 chars < default min_prompt_chars=20
      bindings: new Map<string, unknown>(),
      sessionId: sid,
      packId: 'test-pack',
    };
    const result = await registry.call('recall_pre_inject', {}, ctx);

    // Short prompt → no recall call even though goal-token would make the
    // composed query long. The skip is on the raw prompt by design.
    expect(recall).toHaveBeenCalledTimes(0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });
});

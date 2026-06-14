/**
 * Tests for `rubric_pre_inject` (TR.B, wg-2d1d8698f563): injects the FULL coding-flow rubric at
 * prompt_submit while the FSM is in an active SCOPE/AUTHOR phase; null otherwise. Uses a temp OPENSQUID_HOME
 * + advanceFsmState to set the coding-flow FSM, and reads the real docs/rubric/ fragments (1:1 with the audit).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { advanceFsmState } from '../runtime/fsm_state.js';
import { ok } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

import { readRubricContent } from './read_rubric.js';
import { registerRubricPreInject } from './rubric_pre_inject.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';
import { loadPack } from '../packs/loader.js';

const SID = 'rpi-test';
const TS = '2026-06-13T00:00:00.000Z';
const promptEvent: Event = { kind: 'prompt_submit', prompt: 'go' };

function reg(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerRubricPreInject(r);
  return r;
}
function ctx(event: Event): EvalCtx {
  return { event, bindings: new Map<string, unknown>(), sessionId: SID, packId: 'coding-flow' };
}

describe('rubric_pre_inject', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-rpi-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('returns null on a non-prompt_submit event', async () => {
    const r = await reg().call(
      'rubric_pre_inject',
      {},
      ctx({ kind: 'tool_call', tool: 'Write', args: {} }),
    );
    expect(r).toEqual(ok(null));
  });

  it('returns null when the coding-flow FSM is unstarted (idle / no state)', async () => {
    expect(await reg().call('rubric_pre_inject', {}, ctx(promptEvent))).toEqual(ok(null));
  });

  it('injects the FULL rubric (scope + author, 1:1 with the audit source) in an active AUTHOR phase', async () => {
    const pack = await loadPack(resolve('packs/builtin/coding-flow'));
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, 'scope_start', TS); // → scoping
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, 'research_done', TS); // → researched (pre-spec-write authoring window)
    const r = await reg().call('rubric_pre_inject', {}, ctx(promptEvent));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ kind: 'inject_context' });
    const { content } = r.value as { content: string };
    // 1:1 with the audit's read_rubric source — both fragments embedded whole.
    expect(content).toContain((await readRubricContent('scope'))!);
    expect(content).toContain((await readRubricContent('author'))!);
  });

  it('returns null at a terminal phase (phases_complete — no rubric owed)', async () => {
    const pack = await loadPack(resolve('packs/builtin/coding-flow'));
    for (const ev of [
      'scope_start',
      'research_done',
      'spec_drafted',
      'spec_verified',
      'tasks_loaded',
      'phase_started',
      'phases_done',
    ]) {
      await advanceFsmState(SID, 'coding-flow', pack.fsm!, ev, TS);
    }
    expect(await reg().call('rubric_pre_inject', {}, ctx(promptEvent))).toEqual(ok(null));
  });
});

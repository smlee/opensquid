/**
 * Tests for `phase_inject` (GI.4) — channel (a): the merged turn-boundary injector. Emits the CURRENT
 * phase's bundle EVERY turn (refresh; idle→SCOPE — the lifted suppression) + writes the dedup phase key.
 * Uses a temp OPENSQUID_HOME + advanceFsmState; rubrics resolve from the real pack location (GI.1).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { advanceFsmState } from '../runtime/fsm_state.js';
import { sessionStateFile } from '../runtime/paths.js';
import { ok } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

import { loadPack } from '../packs/loader.js';
import { PHASE_KEY, registerPhaseInject } from './phase_inject.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

const SID = 'phase-inject-test';
const TS = '2026-06-20T00:00:00.000Z';
// A procedure.md-shaped fixture with the five sections the selector splits.
const PROC = [
  '# title',
  '## 0. Pick the flow by request type',
  'pick the flow.',
  '## 1. SCOPE — gate: guess-audit',
  'write the pre-research.',
  '## 2. AUTHOR — gate: spec-audit',
  'write the 11-field spec.',
  '## 3. CODE — gate: phase-log',
  'log all 7 phases.',
  '## On a BLOCK',
  'do the named step.',
].join('\n');
const prompt: Event = { kind: 'prompt_submit', prompt: 'go' };

function reg(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerPhaseInject(r);
  return r;
}
function ctx(event: Event, packProcedure?: string): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: SID,
    packId: 'coding-flow',
    ...(packProcedure !== undefined ? { packProcedure } : {}),
  };
}

describe('phase_inject (channel a)', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-pi-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('returns null on a non-prompt/session event', async () => {
    expect(
      await reg().call('phase_inject', {}, ctx({ kind: 'tool_call', tool: 'Write', args: {} }, PROC)),
    ).toEqual(ok(null));
  });

  it('returns null when the pack ships no procedure', async () => {
    expect(await reg().call('phase_inject', {}, ctx(prompt))).toEqual(ok(null));
  });

  it('returns null at idle/unstarted (not engaged → no non-work noise)', async () => {
    // No advance → unstarted → not in a track. A work cold-start is oriented because enter-scoping arms
    // scoping FIRST (file order); a non-work prompt stays idle → nothing injected.
    expect(await reg().call('phase_inject', {}, ctx(prompt, PROC))).toEqual(ok(null));
  });

  it('injects the SCOPE bundle when ENGAGED (scoping) + writes the phase key', async () => {
    const pack = await loadPack(resolve('packs/builtin/coding-flow'));
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, 'scope_start', TS); // idle → scoping
    const r = await reg().call('phase_inject', {}, ctx(prompt, PROC));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ kind: 'inject_context' });
    const { content } = r.value as { content: string };
    expect(content).toContain('write the pre-research'); // §1 SCOPE
    expect(content).toContain('pick the flow'); // §0 always-on
    expect(content).toContain('do the named step'); // §On-a-BLOCK
    expect(content).toContain('NEVER-GUESS'); // the real scope rubric (pack location)
    expect(content).not.toContain('write the 11-field'); // NOT §2
    const key = JSON.parse(await readFile(sessionStateFile(SID, PHASE_KEY), 'utf8')) as { phase: string };
    expect(key.phase).toBe('SCOPE');
  });

  it('injects the AUTHOR bundle once the FSM reaches an AUTHOR state', async () => {
    const pack = await loadPack(resolve('packs/builtin/coding-flow'));
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, 'scope_start', TS); // idle → scoping
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, 'research_done', TS); // scoping → researched (AUTHOR)
    const r = await reg().call('phase_inject', {}, ctx(prompt, PROC));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { content } = r.value as { content: string };
    expect(content).toContain('write the 11-field'); // §2 AUTHOR
    expect(content).toContain('11-FIELD'); // the real author rubric
    expect(content).not.toContain('write the pre-research'); // NOT §1
    const key = JSON.parse(await readFile(sessionStateFile(SID, PHASE_KEY), 'utf8')) as { phase: string };
    expect(key.phase).toBe('AUTHOR');
  });
});

/**
 * CFD.3 / PG.3 — phase_bundle_text tests. Mirrors phase_inject.test's harness (temp OPENSQUID_HOME +
 * persistActorState; rubrics resolve from the real shipped pack). Verifies the bundle is routed by the RAW
 * FSM state (a CODE state must NOT collapse to SCOPE — the spec-audit-caught bug) and that CODE has no rubric.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persistActorState } from '../runtime/fsm_state.js';
import { ok } from '../runtime/result.js';
import type { Event } from '../runtime/types.js';

import { registerPhaseBundleText } from './phase_bundle_text.js';
import { type EvalCtx, FunctionRegistry } from './registry.js';

const SID = 'phase-bundle-text-test';
const TS = '2026-06-25T00:00:00.000Z';
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
const stop: Event = { kind: 'stop', assistantText: '' };

function reg(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerPhaseBundleText(r);
  return r;
}
function ctx(packProcedure?: string): EvalCtx {
  return {
    event: stop,
    bindings: new Map<string, unknown>(),
    sessionId: SID,
    packId: 'coding-flow',
    ...(packProcedure !== undefined ? { packProcedure } : {}),
  };
}

describe('phase_bundle_text (PG.3)', () => {
  let home: string;
  let prior: string | undefined;
  beforeEach(async () => {
    prior = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-pbt-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = prior;
    await rm(home, { recursive: true, force: true });
  });

  it('returns empty text when the pack ships no procedure', async () => {
    expect(await reg().call('phase_bundle_text', {}, ctx())).toEqual(ok({ text: '' }));
  });

  it('at a SCOPE state, the bundle carries the SCOPE section + the scope rubric', async () => {
    // No FSM state persisted → readFsmStateRaw null → 'idle' → SCOPE.
    const res = (await reg().call('phase_bundle_text', {}, ctx(PROC))) as {
      value: { text: string };
    };
    expect(res.value.text).toContain('## 1. SCOPE');
    expect(res.value.text).toContain('## On a BLOCK'); // always-on section
    expect(res.value.text).toContain('NEVER-GUESS'); // the real scope rubric
    expect(res.value.text).not.toContain('## 3. CODE'); // not the CODE section
  });

  it('at a CODE state, the bundle carries the CODE section and NO rubric (CODE→none) — raw state, not collapsed to SCOPE', async () => {
    await persistActorState(SID, 'coding-flow', 'phases_in_flight', TS);
    const res = (await reg().call('phase_bundle_text', {}, ctx(PROC))) as {
      value: { text: string };
    };
    expect(res.value.text).toContain('## 3. CODE');
    expect(res.value.text).not.toContain('## 1. SCOPE');
    expect(res.value.text).not.toContain('NEVER-GUESS'); // CODE has no rubric (select_phase_bundle.ts:88)
  });
});

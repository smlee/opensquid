/**
 * Slice 1 — the `fullstack-flow` pack skeleton.
 *
 * Proves the FIRST real v2 `pack.yaml` (packs/builtin/fullstack-flow/pack.yaml): it parses (PackV2), compiles
 * (compilePackV2), passes validateFsm, and ADVANCES on hook events through the live observed runtime
 * (V2ObservedActor) — SCOPE → PLAN → AUTHOR → CODE → DEPLOY → (acceptance decision) → loop back to PLAN (the
 * deferred-acceptance default; a skeleton never auto-ships). Spec: loop/docs/tasks/T-v2-coding-flow-skeleton.md.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateFsm } from '../runtime/fsm.js';
import { loadPackV2 } from './loader_v2.js';
import { V2ObservedActor } from '../runtime/loop/v2_observed_actor.js';
import type { Envelope, MessageKind } from '../runtime/bus/types.js';

const BUILTIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packs',
  'builtin',
  'fullstack-flow',
);

/** A hook-event envelope with the host-shaped ctx (buildGuardCtx binds `event` = the kind). */
function env(kind: MessageKind): Envelope {
  const ctx = new Map<string, unknown>([['event', kind]]);
  return { seq: 1, from: 'agent', to: 'pack:fullstack-flow', kind, payload: { ctx }, ts: 0 };
}

describe('fullstack-flow pack skeleton (Slice 1)', () => {
  it('loads, compiles, and passes validateFsm', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    expect(loaded.pack.name).toBe('fullstack-flow');
    expect(loaded.pack.scope).toBe('workflow');
    // serves the build cell so the orchestrator can route to it.
    expect(loaded.pack.serves).toEqual({ intent: 'produce', domain: 'coding' });
    const fsm = loaded.compiled.fsm;
    expect(fsm).toBeDefined();
    expect(validateFsm(fsm!)).toEqual([]); // every emit routed, targets declared, decision totality
  });

  it('advances through the 5-stage lifecycle on hook events (acceptance loops back — handler deferred)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    expect(a.state.current).toBe('scope'); // initial

    await a.receive(env('prompt_submit')); // SCOPE gate fires → PLAN
    expect(a.state.current).toBe('plan');

    await a.receive(env('post_tool_call')); // PLAN → AUTHOR
    expect(a.state.current).toBe('author');
    await a.receive(env('post_tool_call')); // AUTHOR → CODE
    expect(a.state.current).toBe('code');
    await a.receive(env('post_tool_call')); // CODE → DEPLOY
    expect(a.state.current).toBe('deploy');

    // DEPLOY passes → acceptance decision auto-resolves: `accepted` is unbound → else → loop back to PLAN.
    await a.receive(env('post_tool_call'));
    expect(a.state.current).toBe('plan');
  });

  it('a gate at an await-point ignores a non-trigger observation (no spurious advance)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    // SCOPE waits for prompt_submit; a post_tool_call must NOT advance it.
    const effects = await a.receive(env('post_tool_call'));
    expect(effects).toEqual([]);
    expect(a.state.current).toBe('scope');
  });
});

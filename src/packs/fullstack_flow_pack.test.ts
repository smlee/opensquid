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
import { loadPackV2, type LoadedPackV2 } from './loader_v2.js';
import { V2ObservedActor } from '../runtime/loop/v2_observed_actor.js';
import type { Effect } from '../runtime/actor/port.js';
import type { Envelope, MessageKind } from '../runtime/bus/types.js';

const BUILTIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packs',
  'builtin',
  'fullstack-flow',
);

/** A hook-event envelope with the host-shaped ctx (buildGuardCtx binds `event` = the kind + extra keys). */
function env(kind: MessageKind, extra: Record<string, unknown> = {}): Envelope {
  const ctx = new Map<string, unknown>([['event', kind], ...Object.entries(extra)]);
  return { seq: 1, from: 'agent', to: 'pack:fullstack-flow', kind, payload: { ctx }, ts: 0 };
}

/** The bound ctx for a READY SCOPE advance (T2.4): the nested `scope` object the `scope_ready` guard reads. */
const scopeReady = {
  scope: { is_advance: true, anchors_ok: true, depth: 3, open_question: false },
};

/** The bound ctx for a READY PLAN advance (T2.5): the nested `plan` object the `plan_ready` guard reads. */
const planReady = { plan: { acyclic: true, complete: true } };

/** The bound ctx for a READY AUTHOR advance (T2.6): the nested `author` object the `author_ready` guard reads. */
const authorReady = { author: { coverage_complete: true, real_code: true } };

/** A V2ObservedActor over the compiled inner `code_cycle` flow (T2.7) — the per-task CODE machine, driven in
 *  isolation. The flow shares the parent's `guardExprs` (compile_v2.ts:181), so `code_ready` resolves. */
function childActor(loaded: LoadedPackV2): V2ObservedActor {
  const cc = loaded.compiled.flows?.code_cycle;
  if (cc === undefined) throw new Error('test setup: no compiled code_cycle flow');
  return new V2ObservedActor('pack:fullstack-flow/code_cycle', { ...loaded, compiled: cc });
}

/** True iff the effects contain a `block` gate_action (the ENFORCE observation). */
function blockedIn(effects: Effect[]): boolean {
  return effects.some(
    (e) =>
      e.kind === 'emit' &&
      e.messageKind === 'gate_action' &&
      (e.payload as { action?: string }).action === 'block',
  );
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

  it('advances SCOPE → PLAN → AUTHOR → CODE; CODE is the T2.7 sub_flow await-point (observed mode)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    expect(a.state.current).toBe('scope'); // initial

    // SCOPE is now the T2.4 ENFORCING gate (post_tool_call-triggered, blocking). A READY advance passes → PLAN.
    await a.receive(env('post_tool_call', scopeReady)); // SCOPE gate fires → PLAN
    expect(a.state.current).toBe('plan');

    // PLAN is now the T2.5 ENFORCING gate (acyclic ∧ complete). A READY plan passes → AUTHOR.
    await a.receive(env('post_tool_call', planReady)); // PLAN → AUTHOR
    expect(a.state.current).toBe('author');

    // AUTHOR is now the T2.6 ENFORCING gate (coverage_complete ∧ real_code). A READY author passes → CODE.
    await a.receive(env('post_tool_call', authorReady)); // AUTHOR → CODE
    expect(a.state.current).toBe('code');

    // T2.7 — CODE is now a `sub_flow` (its per-task ENFORCING `code_cycle` gate). An `executor`/`sub_flow` state
    // is inert in OBSERVED mode (v2_observed_actor.ts:74 — only gate/decision states advance), so the observed
    // actor parks AT `code` (the await-point). The inner `code_cycle` gate's results-gating (pass/BLOCK on
    // phases_complete ∧ readiness_ran ∧ deprecated_clean) is proven directly below over the compiled flow.
    await a.receive(env('post_tool_call'));
    expect(a.state.current).toBe('code');
  });

  it('T2.7: the compiled `code_cycle` flow exists with a `code_ready` gate (results-gated, on_fail block)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const cc = loaded.compiled.flows?.code_cycle;
    expect(cc).toBeDefined();
    expect(validateFsm(cc!.fsm!)).toEqual([]);
    const coding = cc!.meta.coding;
    expect(coding).toBeDefined();
    expect(coding?.kind).toBe('gate');
    expect(coding?.guard).toBe('code_ready');
    expect(coding?.onFail?.action).toBe('block'); // a not-ready CODE BLOCKS (never a warn pass-through)
    // the guard predicates on ALL THREE results (proves results-gating, not just "ran").
    expect(loaded.compiled.guardExprs?.get('code_ready')).toBe(
      'code.phases_complete && code.readiness_ran && code.deprecated_clean',
    );
  });

  it('T2.7: the inner CODE gate PASSES on phases_complete ∧ readiness_ran ∧ deprecated_clean', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const child = childActor(loaded);
    expect(child.state.current).toBe('coding');
    const ready = { code: { phases_complete: true, readiness_ran: true, deprecated_clean: true } };
    await child.receive(env('post_tool_call', ready));
    expect(child.state.current).toBe('committed'); // gate passed → nested terminal (emits `coded`)
  });

  it('T2.7: a deprecated hit (deprecated_clean:false) BLOCKS — proves results-gating, not just "ran"', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const child = childActor(loaded);
    // phases complete + readiness RAN, but a deprecated-syntax hit → deprecated_clean:false → BLOCK.
    const ran = { code: { phases_complete: true, readiness_ran: true, deprecated_clean: false } };
    const effects = await child.receive(env('post_tool_call', ran));
    expect(child.state.current).toBe('coding'); // blocked → stayed
    expect(blockedIn(effects)).toBe(true);
  });

  it('T2.7: an incomplete phase ledger (phases_complete:false) BLOCKS', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const child = childActor(loaded);
    const incomplete = {
      code: { phases_complete: false, readiness_ran: true, deprecated_clean: true },
    };
    const effects = await child.receive(env('post_tool_call', incomplete));
    expect(child.state.current).toBe('coding');
    expect(blockedIn(effects)).toBe(true);
  });

  it('T2.7: a never-run readiness (readiness_ran:false, fail-closed) BLOCKS', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const child = childActor(loaded);
    // the fail-closed shape buildGuardCtx binds when readinessResult never ran (all three false).
    const failClosed = {
      code: { phases_complete: false, readiness_ran: false, deprecated_clean: false },
    };
    const effects = await child.receive(env('post_tool_call', failClosed));
    expect(child.state.current).toBe('coding');
    expect(blockedIn(effects)).toBe(true);
  });

  it('a gate at an await-point ignores a non-trigger observation (no spurious advance)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    // SCOPE now waits for post_tool_call (T2.4); a prompt_submit must NOT advance it.
    const effects = await a.receive(env('prompt_submit'));
    expect(effects).toEqual([]);
    expect(a.state.current).toBe('scope');
  });

  it('T2.4: a NOT-READY SCOPE advance BLOCKS (stays at scope, emits the block action)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    // is_advance true but anchors_ok false → the predicate fails → on_fail block.
    const notReady = {
      scope: { is_advance: true, anchors_ok: false, depth: 0, open_question: false },
    };
    const effects = await a.receive(env('post_tool_call', notReady));
    expect(a.state.current).toBe('scope'); // blocked → stayed
    const blocked = effects.some(
      (e) =>
        e.kind === 'emit' &&
        e.messageKind === 'gate_action' &&
        (e.payload as { action?: string }).action === 'block',
    );
    expect(blocked).toBe(true);
  });

  it('T2.5: an incomplete/cyclic PLAN BLOCKS (stays at plan, emits the block action)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    await a.receive(env('post_tool_call', scopeReady)); // → plan
    expect(a.state.current).toBe('plan');
    // plan.complete false (an uncovered element) → predicate fails → on_fail block.
    const notReady = { plan: { acyclic: true, complete: false } };
    const effects = await a.receive(env('post_tool_call', notReady));
    expect(a.state.current).toBe('plan'); // blocked → stayed
    const blocked = effects.some(
      (e) =>
        e.kind === 'emit' &&
        e.messageKind === 'gate_action' &&
        (e.payload as { action?: string }).action === 'block',
    );
    expect(blocked).toBe(true);
  });

  it('T2.6: an AUTHOR with orphans or a failing proof BLOCKS (stays at author, emits the block action)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    await a.receive(env('post_tool_call', scopeReady)); // → plan
    await a.receive(env('post_tool_call', planReady)); // → author
    expect(a.state.current).toBe('author');
    // real_code false (a failing/absent proof-test) → predicate fails → on_fail block.
    const notReady = { author: { coverage_complete: true, real_code: false } };
    const effects = await a.receive(env('post_tool_call', notReady));
    expect(a.state.current).toBe('author'); // blocked → stayed
    const blocked = effects.some(
      (e) =>
        e.kind === 'emit' &&
        e.messageKind === 'gate_action' &&
        (e.payload as { action?: string }).action === 'block',
    );
    expect(blocked).toBe(true);
  });

  it('T2.4: a non-advance post_tool_call short-circuits PASS (advances; never blocks mid-scoping)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    // is_advance false → `!scope.is_advance` short-circuits true → gate passes without inspecting anchors.
    await a.receive(env('post_tool_call', { scope: { is_advance: false } }));
    expect(a.state.current).toBe('plan');
  });
});

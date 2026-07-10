/**
 * The `fullstack-flow` pack — the v2 enforcing discipline (T2.1).
 *
 * Proves the real v2 `pack.yaml` (packs/builtin/fullstack-flow/pack.yaml): it parses (PackV2), compiles
 * (compilePackV2), passes validateFsm, and ADVANCES on hook events through the live observed runtime
 * (V2ObservedActor) — SCOPE → PLAN → AUTHOR → CODE → DEPLOY → (acceptance decision) → loop back to PLAN (the
 * deferred-acceptance default; never auto-ships). Each stage is now a DETERMINISTIC, ZERO-LLM ENFORCING gate
 * (T2.4–T2.8): a not-ready advance BLOCKS. Spec: loop/docs/tasks/T-v2-track2-discipline.md (T2.1).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { validateFsm } from '../runtime/fsm.js';
import { loadPackV2, type LoadedPackV2 } from './loader_v2.js';
import { lintPhaseEmits } from './phase_emit_lint.js';
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

/** The guess-free verdict text the content-audit producer caches (GFR.2 `contains(audit.<stage>, …)`). */
const GF = 'VERDICT: GUESS_FREE';

/** A READY SCOPE advance (T2.4): the deterministic `scope` facets + the GFR.2 guess-free verdict. */
const scopeReady = {
  scope: { is_advance: true, anchors_ok: true, depth: 3, open_question: false },
  audit: { scope: GF },
};

/** A READY PLAN advance (T2.5): the `plan` facets + the PLAN verdict + (GFR.3 rolling) the prior SCOPE verdict. */
const planReady = { plan: { acyclic: true, complete: true }, audit: { scope: GF, plan: GF } };

/** A READY AUTHOR advance (T2.6): the `author` facets + the AUTHOR verdict + (GFR.3 rolling) the prior PLAN verdict. */
const authorReady = {
  author: { manifest_complete: true, real_code: true },
  audit: { plan: GF, author: GF },
};

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

describe('fullstack-flow pack — v2 enforcing discipline (T2.1)', () => {
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

  it('SCOPE dwells (no-op); the automated chain SCOPE_WRITE → PLAN → AUTHOR → CODE advances from scope_write', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    expect(a.state.current).toBe('scope'); // initial

    // SCOPE is the interactive NO-OP resting state (no trigger): even a READY-looking advance shape does NOTHING.
    // The FSM dwells at scope until the human confirms — nothing an agent does in-session leaves SCOPE.
    const dwell = await a.receive(env('post_tool_call', scopeReady));
    expect(dwell).toEqual([]); // no advance, no block
    expect(a.state.current).toBe('scope');

    // Automation begins at scope_write (the lap boots there on the user's confirmation, v2_supply.ts:616-623).
    // Seed there and drive the automated chain.
    a.state.current = 'scope_write';
    await a.receive(env('post_tool_call', scopeReady)); // SCOPE_WRITE gate fires → PLAN
    expect(a.state.current).toBe('plan');

    // PLAN is the T2.5 ENFORCING gate (acyclic ∧ complete). A READY plan passes → AUTHOR.
    await a.receive(env('post_tool_call', planReady)); // PLAN → AUTHOR
    expect(a.state.current).toBe('author');

    // AUTHOR is the T2.6 ENFORCING gate (manifest_complete ∧ real_code). A READY author passes → CODE.
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
    // the guard predicates on ALL THREE results (proves results-gating, not just "ran") + the GFR.2 CODE verdict
    // + the GFR.3 rolling re-assert of the prior AUTHOR verdict.
    const codeExpr = loaded.compiled.guardExprs?.get('code_ready') ?? '';
    expect(codeExpr).toContain('code.phases_complete');
    expect(codeExpr).toContain('code.readiness_ran');
    expect(codeExpr).toContain('code.deprecated_clean');
    expect(codeExpr).toContain('code.suite_green'); // SGG.3 — the appended FULL-verifySuite-green term
    expect(codeExpr).toContain('report.resolved'); // V2-ENF.2/3 — block-on-unresolved report-resolution facet
    expect(codeExpr).toContain('contains(audit.code, "VERDICT: GUESS_FREE")'); // GFR.2
    expect(codeExpr).toContain('contains(audit.author, "VERDICT: GUESS_FREE")'); // GFR.3 rolling
  });

  it('SGG.1: procedure/code.md `test`-phase mandate names the declared verifySuite + EXIT 0 (not vague)', () => {
    const codeMd = readFileSync(join(BUILTIN_DIR, 'procedure', 'code.md'), 'utf8');
    // the mandate must name the DECLARED suite (not hardcode a command) and require a clean full run…
    expect(codeMd).toContain('verifySuite');
    expect(codeMd).toContain('EXIT 0');
    // …and forbid the false-green slice + tie to the gate (so a future edit that re-vaguens it fails here).
    expect(codeMd).toContain('code.suite_green');
    expect(codeMd.toLowerCase()).toContain('slice');
  });

  it('LMP.3 (repurposed, scope-3): CODE drives the enforced log_phase feed + no procedure carries the retired "silent" false promise (the live path)', () => {
    const stages = ['scope', 'scope_write', 'plan', 'author', 'code', 'deploy'];
    const procs = stages.map((s) => ({
      stage: s,
      text: readFileSync(join(BUILTIN_DIR, 'procedure', `${s}.md`), 'utf8'),
    }));
    const results = lintPhaseEmits(procs);
    // The enforced-feed invariant holds for all six real procedures: CODE drives log_phase, none carries the
    // retired "Without this … silent" false promise; a failure NAMES the offending stage.
    const bad = results.filter((r) => !r.ok);
    expect(bad, `offending stages: ${JSON.stringify(bad)}`).toEqual([]);
    // and a synthetic CODE procedure that dropped the log_phase mandate is caught, missing NAMED.
    const neg = lintPhaseEmits([{ stage: 'code', text: 'run the 7 phases; set_loop_phase only.' }]);
    expect(neg[0]?.ok).toBe(false);
    expect(neg[0]?.missing).toContain(
      'CODE must drive the enforced log_phase feed (no log_phase( mandate)',
    );
    // a procedure carrying the retired "Without this … silent" false promise is also caught.
    const falsePromise = lintPhaseEmits([
      { stage: 'code', text: 'log_phase(<phase>). Without this, CODE is SILENT on the feed.' },
    ]);
    expect(falsePromise[0]?.ok).toBe(false);
    expect(falsePromise[0]?.missing).toContain(
      'carries the retired set_loop_phase "silent" false promise',
    );
  });

  it('T2.7: the inner CODE gate PASSES on phases_complete ∧ readiness_ran ∧ deprecated_clean ∧ suite_green', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const child = childActor(loaded);
    expect(child.state.current).toBe('coding');
    // the four `code.*` facets (incl. SGG.2 suite_green) + the CODE verdict (GFR.2) + the prior AUTHOR verdict
    // (GFR.3 rolling) + the resolved report-checklist facet (V2-ENF.2/3 — resolved here so it doesn't hold).
    const ready = {
      code: {
        phases_complete: true,
        readiness_ran: true,
        deprecated_clean: true,
        suite_green: true,
        arch_clean: true, // AQG.4 — undeclared detector fails OPEN; the gate now includes && code.arch_clean
      },
      report: { resolved: true },
      audit: { author: GF, code: GF },
    };
    await child.receive(env('post_tool_call', ready));
    expect(child.state.current).toBe('committed'); // gate passed → nested terminal (emits `coded`)
  });

  it('SGG.2/3: a red/absent full suite (suite_green:false) BLOCKS — kills the false-green slice', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const child = childActor(loaded);
    // every other CODE facet green, but the FULL declared verifySuite was not recorded green (a slice run) →
    // suite_green:false → code_ready BLOCKS. This is the exact false-green a 116-test slice hid before SGG.
    const sliceRun = {
      code: {
        phases_complete: true,
        readiness_ran: true,
        deprecated_clean: true,
        suite_green: false,
      },
      report: { resolved: true },
      audit: { author: GF, code: GF },
    };
    const effects = await child.receive(env('post_tool_call', sliceRun));
    expect(child.state.current).toBe('coding'); // blocked → stayed
    expect(blockedIn(effects)).toBe(true);
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
    // SCOPE has no trigger (interactive no-op resting state); a prompt_submit is a no-op like every other event.
    const effects = await a.receive(env('prompt_submit'));
    expect(effects).toEqual([]);
    expect(a.state.current).toBe('scope');
  });

  it('T2.4: SCOPE never blocks and never advances on a tool call — it DWELLS (interactive no-op)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    // Even a "ready advance" shape (the exact input that USED to advance scope→scope_write) is now a no-op:
    // SCOPE has no trigger, so the FSM does nothing — no advance AND no block. It waits for the human.
    const notReady = {
      scope: { is_advance: true, anchors_ok: false, depth: 0, open_question: false },
    };
    const effects = await a.receive(env('post_tool_call', notReady));
    expect(a.state.current).toBe('scope'); // dwelled
    expect(effects).toEqual([]); // no advance, no block — SCOPE is inert to tool calls
  });

  it('T2.5: an incomplete/cyclic PLAN BLOCKS (stays at plan, emits the block action)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    // PLAN is an AUTOMATION stage — seed there directly (SCOPE dwells now; the lap boots past it to scope_write).
    const a = seedAt(loaded, 'plan');
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
    // AUTHOR is an AUTOMATION stage — seed there directly (SCOPE dwells; the lap drives the automated chain).
    const a = seedAt(loaded, 'author');
    expect(a.state.current).toBe('author');
    // real_code false (a failing/absent proof-test) → predicate fails → on_fail block.
    const notReady = { author: { manifest_complete: true, real_code: false } };
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

  it('T2.4: a plain (non-advance) post_tool_call during SCOPE is a NO-OP — it dwells, never reaches scope_write', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    // This is the exact bug that used to auto-eject SCOPE: a non-advance tool call passing `!scope.is_advance`
    // and advancing to scope_write. With the trigger removed, SCOPE dwells — the tool call does nothing.
    const effects = await a.receive(env('post_tool_call', { scope: { is_advance: false } }));
    expect(effects).toEqual([]);
    expect(a.state.current).toBe('scope'); // dwelled — SCOPE only leaves on the user's confirmation
  });

  // ── T2.8 — the DEPLOY capability gate + the durable acceptance decision (never auto-ship) ──────────────────

  /** Seed the top-level actor at a given state (the observed sub_flow at CODE is inert, so deploy/accept are
   *  driven from a seeded state — mirrors v2_supply's `actor.state.current = …` resume seam). */
  function seedAt(loaded: LoadedPackV2, state: string): V2ObservedActor {
    const a = new V2ObservedActor('pack:fullstack-flow', loaded);
    a.state.current = state;
    return a;
  }

  it('T2.8: the DEPLOY gate uses `deploy_ready` (deploy.capability_ok), on_fail block', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const deploy = loaded.compiled.meta.deploy;
    expect(deploy?.kind).toBe('gate');
    expect(deploy?.guard).toBe('deploy_ready');
    expect(deploy?.onFail?.action).toBe('block'); // never a warn pass-through
    expect(loaded.compiled.guardExprs?.get('deploy_ready')).toBe('deploy.capability_ok');
    expect(loaded.compiled.guardExprs?.get('accepted')).toBe('deploy.accepted');
  });

  it('T2.8: capability_ok PASSES the DEPLOY gate, then VERIFY(clean)→accept→done (DBL.1)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'deploy');
    // capability_ok true → the gate passes; VERIFY(deploy.clean true)→verified→accept; accepted:true → done.
    await a.receive(
      env('post_tool_call', { deploy: { capability_ok: true, clean: true, accepted: true } }),
    );
    expect(a.state.current).toBe('done');
  });

  it('scope-2: a MECHANICAL red (deploy.clean:false, needs_redesign:false) routes to DEPLOY-LOCAL fix, NOT AUTHOR', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const verify = loaded.compiled.meta.verify;
    expect(verify?.kind).toBe('decision');
    expect(loaded.compiled.guardExprs?.get('deploy_clean')).toBe('deploy.clean');
    expect(loaded.compiled.guardExprs?.get('deploy_needs_redesign')).toBe('deploy.needs_redesign');
    // deploy_fix is a gate whose EXIT condition re-checks every loop-terminal facet (clean/exhausted/redesign),
    // so the cap/redesign escapes are reachable from INSIDE the fix loop (scope-2 §5.3 — not deploy.clean alone).
    expect(loaded.compiled.meta.deploy_fix?.kind).toBe('gate');
    expect(loaded.compiled.meta.deploy_fix?.guard).toBe('deploy_fix_exit');
    expect(loaded.compiled.guardExprs?.get('deploy_fix_exit')).toBe(
      'deploy.clean || deploy.bugfix_exhausted || deploy.needs_redesign',
    );
    expect(loaded.compiled.meta.deploy_fix?.onFail?.action).toBe('block');
    const a = seedAt(loaded, 'deploy');
    // capability_ok passes the gate; VERIFY(clean:false, needs_redesign default false) → bugs_local → DEPLOY_FIX.
    await a.receive(
      env('post_tool_call', {
        deploy: { capability_ok: true, clean: false, needs_redesign: false, accepted: false },
      }),
    );
    expect(a.state.current).toBe('deploy_fix'); // §5.1 NARROWING: mechanical red fixed IN DEPLOY, not via AUTHOR
  });

  it('scope-2: a REDESIGN-flagged red (deploy.needs_redesign:true) routes to AUTHOR (the narrowed escape hatch)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'deploy');
    // capability_ok passes the gate; VERIFY(clean:false, needs_redesign:true) → bugs_need_redesign → AUTHOR.
    await a.receive(
      env('post_tool_call', {
        deploy: { capability_ok: true, clean: false, needs_redesign: true, accepted: false },
      }),
    );
    expect(a.state.current).toBe('author'); // §5.1: ONLY a genuine design-rework signal leaves DEPLOY to re-author
  });

  it('scope-2: the DEPLOY-local fix loop reaches clean → re-VERIFY → ACCEPT (deploy_fix → verify → accept → done)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'deploy_fix');
    // The agent fixed + re-ran the suite green: deploy_fix(clean:true) → fix_verified → verify → verified →
    // accept → (accepted:true) → done. The in-place fix loop completes without ever routing through AUTHOR.
    await a.receive(env('post_tool_call', { deploy: { clean: true, accepted: true } }));
    expect(a.state.current).toBe('done');
  });

  it('scope-2: deploy_fix BLOCKS on a still-red suite (stays in deploy_fix — no ship on red)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'deploy_fix');
    const effects = await a.receive(env('post_tool_call', { deploy: { clean: false } }));
    expect(a.state.current).toBe('deploy_fix'); // still red → held in the fix loop
    expect(blockedIn(effects)).toBe(true);
  });

  it('scope-2 §5.3: an EXHAUSTED red INSIDE deploy_fix escalates to the human (deploy_fix → verify → accept → plan)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'deploy_fix');
    // Still mechanically red, but a genuinely-unfixable failure has bumped the round count to the cap. The gate
    // must NOT block forever: deploy_fix_exit passes on bugfix_exhausted → fix_verified → verify → bugfix_exhausted
    // → accept → (unaccepted) → plan. This is the regression the deploy.clean-only guard let loop forever.
    await a.receive(
      env('post_tool_call', {
        deploy: { clean: false, bugfix_exhausted: true, accepted: false },
      }),
    );
    expect(a.state.current).toBe('plan'); // bounded escalation from inside the fix loop — never an infinite red loop
  });

  it('scope-2 §5.1: a redesign flag set INSIDE deploy_fix escapes to AUTHOR (deploy_fix → verify → author)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'deploy_fix');
    // `opensquid redesign <taskId>` was run mid-fix-loop: still red, but the red genuinely needs re-authoring. The
    // gate passes on needs_redesign → fix_verified → verify → bugs_need_redesign → author (the §5.1 escape hatch,
    // now reachable from inside the fix loop, not only from the first verify pass).
    await a.receive(
      env('post_tool_call', {
        deploy: { clean: false, needs_redesign: true, accepted: false },
      }),
    );
    expect(a.state.current).toBe('author');
  });

  it('DBL.2: an EXHAUSTED bug-fix loop routes to the human (accept→plan), NOT another author loop', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    expect(loaded.compiled.guardExprs?.get('deploy_bugfix_exhausted')).toBe(
      'deploy.bugfix_exhausted',
    );
    const a = seedAt(loaded, 'deploy');
    // bugs (clean:false) BUT the round cap is hit → verify emits bugfix_exhausted → accept → (unaccepted) → plan.
    await a.receive(
      env('post_tool_call', {
        deploy: { capability_ok: true, clean: false, bugfix_exhausted: true, accepted: false },
      }),
    );
    expect(a.state.current).toBe('plan'); // bounded: human re-plan after exhaustion — NOT an endless author loop
  });

  it('T2.8: capability_ok:false BLOCKS the DEPLOY gate (stays at deploy)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'deploy');
    const effects = await a.receive(
      env('post_tool_call', { deploy: { capability_ok: false, accepted: false } }),
    );
    expect(a.state.current).toBe('deploy'); // blocked → stayed
    expect(blockedIn(effects)).toBe(true);
  });

  it('T2.8: a waiting (unaccepted) item → accept decision LOOPS to plan (never auto-ships)', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'accept');
    // deploy.accepted false (the waiting/absent default) → the `else` branch fires → rejected → plan.
    await a.receive(env('post_tool_call', { deploy: { capability_ok: true, accepted: false } }));
    expect(a.state.current).toBe('plan'); // looped back — NOT done
  });

  it('T2.8: a marked-accepted item → accept decision SHIPS to done', async () => {
    const loaded = await loadPackV2(BUILTIN_DIR);
    const a = seedAt(loaded, 'accept');
    // deploy.accepted true (the human marked the durable item accepted) → the `accepted` branch → done.
    await a.receive(env('post_tool_call', { deploy: { capability_ok: true, accepted: true } }));
    expect(a.state.current).toBe('done');
  });
});

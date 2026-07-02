/**
 * GFR.2 — proves the guess-free verdict ENFORCES on the REAL fullstack-flow gate predicates (loaded from
 * pack.yaml, not a hardcoded copy). Each stage's gate, with its deterministic facets satisfied, still BLOCKS
 * when the stage verdict is absent or UNRESOLVED, and PASSES only on `VERDICT: GUESS_FREE`. evalCondition
 * resolves `audit.<stage>` against the nested `audit` object (the shape buildGuardCtx binds).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { evalCondition } from '../runtime/evaluator/expression/index.js';

import { loadPackV2 } from './loader_v2.js';

const PACK_DIR = resolve(fileURLToPath(import.meta.url), '../../../packs/builtin/fullstack-flow');

/** A ctx Map with the nested gate-evidence objects; `audit` is overridden per case. */
function ctx(audit: Record<string, unknown>): Map<string, unknown> {
  return new Map<string, unknown>([
    // SCOPE advance branch satisfied (is_advance true so the short-circuit doesn't mask the audit clause).
    ['scope', { is_advance: true, anchors_ok: true, depth: 3, open_question: false }],
    ['plan', { acyclic: true, complete: true }],
    ['author', { manifest_complete: true, real_code: true }],
    ['code', { phases_complete: true, readiness_ran: true, deprecated_clean: true }],
    ['audit', audit],
  ]);
}

const GUESS_FREE = 'VERDICT: GUESS_FREE\n- all good';
const UNRESOLVED = 'VERDICT: UNRESOLVED\n- a guess found';

describe('GFR.2 — guess-free gate enforcement (real pack.yaml guards)', () => {
  const stages = ['scope', 'plan', 'author', 'code'] as const;

  it('every stage gate BLOCKS when its facets pass but the verdict is ABSENT (fail-closed)', async () => {
    const { pack } = await loadPackV2(PACK_DIR);
    for (const s of stages) {
      const expr = (pack.guards[`${s}_ready`] ?? '');
      expect(expr, `${s}_ready exists`).toBeTruthy();
      expect(evalCondition(expr, ctx({})), `${s}_ready blocks without verdict`).toBe(false);
    }
  });

  it('every stage gate PASSES only on VERDICT: GUESS_FREE', async () => {
    const { pack } = await loadPackV2(PACK_DIR);
    for (const s of stages) {
      const all = { scope: GUESS_FREE, plan: GUESS_FREE, author: GUESS_FREE, code: GUESS_FREE };
      expect(evalCondition((pack.guards[`${s}_ready`] ?? ''), ctx(all)), `${s}_ready passes`).toBe(true);
    }
  });

  it('every stage gate BLOCKS on VERDICT: UNRESOLVED (a guessed artifact cannot advance)', async () => {
    const { pack } = await loadPackV2(PACK_DIR);
    for (const s of stages) {
      const m = ctx({ [s]: UNRESOLVED });
      expect(evalCondition((pack.guards[`${s}_ready`] ?? ''), m), `${s}_ready blocks on UNRESOLVED`).toBe(false);
    }
  });

  // GFR.3 — the ROLLING re-audit: each post-SCOPE gate re-asserts the IMMEDIATELY-PRIOR stage's verdict, so a
  // prior-stage artifact that drifted after its own gate passed (its content-hash-keyed audit re-evaluates to
  // UNRESOLVED) blocks the NEXT boundary, even when the current stage's own verdict + deterministic facets pass.
  it('GFR.3: a prior-stage drift BLOCKS the next gate (current stage GUESS_FREE + facets pass)', async () => {
    const { pack } = await loadPackV2(PACK_DIR);
    // each entry: the gate, and the immediately-prior stage whose drift must block it
    const rollups = [
      { gate: 'plan_ready', cur: 'plan', prior: 'scope' },
      { gate: 'author_ready', cur: 'author', prior: 'plan' },
      { gate: 'code_ready', cur: 'code', prior: 'author' },
    ] as const;
    for (const { gate, cur, prior } of rollups) {
      // current stage's verdict GUESS_FREE, but the prior stage drifted (UNRESOLVED) → the rolling clause blocks.
      const drifted = ctx({ [cur]: GUESS_FREE, [prior]: UNRESOLVED });
      expect(evalCondition(pack.guards[gate] ?? '', drifted), `${gate} blocks on ${prior} drift`).toBe(false);
      // sanity: with BOTH current + prior GUESS_FREE the same gate passes (proves it was the prior clause blocking).
      const clean = ctx({ [cur]: GUESS_FREE, [prior]: GUESS_FREE });
      expect(evalCondition(pack.guards[gate] ?? '', clean), `${gate} passes when ${prior} holds`).toBe(true);
    }
  });

  it('SCOPE short-circuit still holds: a non-advance event passes regardless of verdict', async () => {
    const { pack } = await loadPackV2(PACK_DIR);
    const m = new Map<string, unknown>([
      ['scope', { is_advance: false }],
      ['audit', {}],
    ]);
    expect(evalCondition(pack.guards.scope_ready ?? '', m)).toBe(true); // !is_advance → pass (never blocks mid-scoping)
  });
});

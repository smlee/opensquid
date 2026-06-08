/**
 * DOG.4 — content tests for the seeded + gated focused/composite packs.
 *
 * Verifies:
 *  - Each focused pack ships ≥ 5 seed_lessons + ≥ 2 verify_gates
 *  - Composite ships ≥ 3 cross-domain seed_lessons + 0 gates (composite
 *    is a pure aggregator at the rule level)
 *  - Every verify_gate's `check` expression PARSES via parseExpression
 *    (load-time gate; would throw at loadPack if it didn't)
 *  - compileVerifyGates(pack) returns {ok: true} for every pack's gates
 *  - loadPack({engine}) fires the ingest pipeline once per pack, with
 *    one engine.lessonCreate call per seed
 *  - Each ingest call carries authored_by: 'pack' + pack_id matching
 *    the pack name + a pack-seed: external_id
 *  - Sum across all 4 packs: ≥ 21 seeds + ≥ 9 gates (acceptance count)
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { compileVerifyGates } from '../../src/packs/verify_gates_compiler.js';
import { parseExpression } from '../../src/runtime/evaluator/expression/index.js';

const FOCUSED = ['focused-react-19', 'focused-typescript-strict', 'focused-atomic-design'] as const;
const COMPOSITE = 'frontend-react-19-atomic';

// (retire-Rust RES-1) seed-ingest tests removed — pack seed_lessons are no longer
// engine-ingested at load (that path was dead). The seed_lessons DATA is still
// validated below (counts, gates, non-empty title/body).

describe('DOG.4 — focused + composite pack content (seed_lessons + verify_gates)', () => {
  for (const name of FOCUSED) {
    it(`${name} ships >= 5 seed_lessons + >= 2 verify_gates`, async () => {
      const pack = await loadPack(resolve('packs/builtin', name));
      expect((pack.seedLessons ?? []).length).toBeGreaterThanOrEqual(5);
      expect((pack.verifyGates ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it(`${name} every verify_gate.check parses via parseExpression`, async () => {
      const pack = await loadPack(resolve('packs/builtin', name));
      for (const gate of pack.verifyGates ?? []) {
        expect(() => parseExpression(gate.check)).not.toThrow();
      }
    });

    it(`${name} compileVerifyGates returns ok with one rule per gate`, async () => {
      const pack = await loadPack(resolve('packs/builtin', name));
      const gates = pack.verifyGates ?? [];
      const r = compileVerifyGates(pack.name, gates);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.skill.rules).toHaveLength(gates.length);
      expect(r.skill.name).toBe(`${name}/verify`);
    });

    it(`${name} synthetic verify skill is folded into pack.skills`, async () => {
      const pack = await loadPack(resolve('packs/builtin', name));
      const synthetic = pack.skills.find((s) => s.name === `${name}/verify`);
      expect(synthetic).toBeDefined();
      const gates = pack.verifyGates ?? [];
      expect(synthetic?.rules.length).toBe(gates.length);
    });
  }

  it('composite frontend-react-19-atomic ships >= 3 cross-domain seed_lessons + 0 gates', async () => {
    const pack = await loadPack(resolve('packs/builtin', COMPOSITE));
    expect((pack.seedLessons ?? []).length).toBeGreaterThanOrEqual(3);
    expect(pack.verifyGates ?? []).toHaveLength(0);
  });

  it('composite carries no synthetic verify skill (composite gates are zero)', async () => {
    const pack = await loadPack(resolve('packs/builtin', COMPOSITE));
    const synthetic = pack.skills.find((s) => s.name === `${COMPOSITE}/verify`);
    expect(synthetic).toBeUndefined();
  });

  it('total seed_lessons across 3 focused + composite is >= 21 (acceptance count)', async () => {
    let total = 0;
    for (const name of [...FOCUSED, COMPOSITE]) {
      const pack = await loadPack(resolve('packs/builtin', name));
      total += (pack.seedLessons ?? []).length;
    }
    expect(total).toBeGreaterThanOrEqual(21);
  });

  it('total verify_gates across 3 focused packs is >= 9 (acceptance count)', async () => {
    let total = 0;
    for (const name of FOCUSED) {
      const pack = await loadPack(resolve('packs/builtin', name));
      total += (pack.verifyGates ?? []).length;
    }
    expect(total).toBeGreaterThanOrEqual(9);
  });

  it('every seed_lesson has non-empty title + body (no placeholder text)', async () => {
    for (const name of [...FOCUSED, COMPOSITE]) {
      const pack = await loadPack(resolve('packs/builtin', name));
      for (const seed of pack.seedLessons ?? []) {
        expect(seed.title.length, `${name}: empty seed title`).toBeGreaterThan(0);
        if (seed.body !== undefined) {
          expect(seed.body.length, `${name}: empty seed body`).toBeGreaterThan(20);
        } else {
          expect(seed.body_path, `${name}: seed has neither body nor body_path`).toBeTruthy();
        }
      }
    }
  });
});

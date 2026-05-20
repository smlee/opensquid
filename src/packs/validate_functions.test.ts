/**
 * Tests for `validatePackFunctions` (Task 2.4).
 *
 * Coverage matches the task spec §"Test fixtures" + acceptance criteria:
 *   1. Pack with one registered + one bogus call → 1 issue, no suggestion
 *      for the bogus call (no near match in the seeded registry).
 *   2. Typo `match_commnd` (1 edit from `match_command`) → suggestion fires.
 *   3. Missing function with no close match (`xyzzy`) → no `suggestion` field.
 *   4. Pack with no skills → empty issues.
 *   5. Pack with two missing calls in the same rule → both reported
 *      (no short-circuit).
 *
 * Each test builds a tiny `FunctionRegistry` with just the primitives needed
 * to keep distance math predictable — full primitive registration is
 * exercised in `src/functions/*.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FunctionRegistry } from '../functions/registry.js';
import { ok } from '../runtime/result.js';
import { Pack } from '../runtime/types.js';

import { validatePackFunctions } from './validate_functions.js';

// ---------------------------------------------------------------------------
// makeRegistry — seed a tiny registry with two real primitive names.
//
// Only the names matter for validation; we stub `execute` so the registry
// satisfies its own contract without depending on the full primitive impls.
// ---------------------------------------------------------------------------

function makeRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  const stubSchema = z.unknown();
  // registry's execute contract returns Promise<Result> but this stub has
  // no awaitable work; matches the same pattern used in
  // src/functions/event.ts + verdict.ts + destination_check.ts.
  // eslint-disable-next-line @typescript-eslint/require-await
  const stubExecute = async () => ok(null);
  reg.register({ name: 'match_command', argSchema: stubSchema, execute: stubExecute });
  reg.register({ name: 'verdict', argSchema: stubSchema, execute: stubExecute });
  return reg;
}

// ---------------------------------------------------------------------------
// makePack — build a `Pack` via `Pack.parse` so defaults flow correctly and
// the test stays type-checked against the runtime schema.
// ---------------------------------------------------------------------------

function makePack(name: string, ruleCalls: string[][]): Pack {
  return Pack.parse({
    name,
    version: '0.0.0',
    scope: 'universal',
    goal: 'test',
    skills:
      ruleCalls.length === 0
        ? []
        : [
            {
              name: 'test-skill',
              rules: ruleCalls.map((calls, i) => ({
                id: `rule-${i}`,
                process: calls.map((c) => ({ call: c })),
              })),
            },
          ],
  });
}

describe('validatePackFunctions', () => {
  it('reports only the missing call when one is registered + one is bogus', () => {
    const pack = makePack('p1', [['match_command', 'bogus_func']]);
    const issues = validatePackFunctions(pack, makeRegistry());

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      pack: 'p1',
      skill: 'test-skill',
      ruleId: 'rule-0',
      step: 1,
      missing: 'bogus_func',
    });
    expect(issues[0]?.suggestion).toBeUndefined();
  });

  it('suggests match_command for typo match_commnd (Levenshtein 1)', () => {
    const pack = makePack('p2', [['match_commnd']]);
    const issues = validatePackFunctions(pack, makeRegistry());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.suggestion).toBe('match_command');
  });

  it('omits the suggestion field when no candidate is within distance 2', () => {
    const pack = makePack('p3', [['xyzzy']]);
    const issues = validatePackFunctions(pack, makeRegistry());

    expect(issues).toHaveLength(1);
    expect(issues[0]?.missing).toBe('xyzzy');
    expect(issues[0]).not.toHaveProperty('suggestion');
  });

  it('returns empty issues for a pack with no skills', () => {
    const pack = makePack('p4', []);
    const issues = validatePackFunctions(pack, makeRegistry());

    expect(issues).toEqual([]);
  });

  it('reports every missing call without short-circuiting', () => {
    const pack = makePack('p5', [['nope_one', 'match_command', 'nope_two']]);
    const issues = validatePackFunctions(pack, makeRegistry());

    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.missing)).toEqual(['nope_one', 'nope_two']);
    expect(issues.map((i) => i.step)).toEqual([0, 2]);
  });
});

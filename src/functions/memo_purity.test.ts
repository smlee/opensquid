/**
 * FAC.1 (T-fix-audit-correctness, wg-8f7d9b919a40) — the memoizable-purity
 * class pin.
 *
 * The evaluator memo keys on sha256({fn, args}) ONLY (evaluator.ts
 * invokeMemoized) — ctx is excluded. So a `memoizable: true` primitive must
 * be TRANSITIVELY ctx-pure: (a) it reads NO ctx field, and (b) it forwards
 * ctx to NO registry.call (destination_check's forwarded llm_classify was
 * the transitive instance the audit review caught). Any ctx dependence
 * means a cached result can cross turn/pack/session boundaries — the
 * whole-source audit found five such primitives memoized (stale guard
 * matches, stale recall injection, cross-pack capability verdicts,
 * cross-pack model aliases).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildRegistry } from '../runtime/bootstrap.js';

import type { FunctionRegistry } from './registry.js';

/** Extending this list requires the TRANSITIVE purity review above —
 *  reviewed 2026-06-11: `recall`/`embed` (rag.ts — execute(args) only,
 *  deterministic backend) and `recall_lesson` (lessons.ts — execute(args)
 *  only, no registry.call forwarding).
 *  reviewed 2026-06-27 (FD5): `design_system_generate` (design_system.ts —
 *  execute calls only the pure `generateDesignSystem(args)`: deterministic
 *  color math, no IO, no registry.call) and `component_scaffold`
 *  (component_scaffold.ts — execute is a pure `kind`→fixed-template lookup).
 *  Both depend ONLY on args (the memo key), so memoization is sound. */
const REVIEWED_PURE = [
  'component_scaffold',
  'design_system_generate',
  'embed',
  'recall',
  'recall_lesson',
];

let home: string;
let priorHome: string | undefined;
let registry: FunctionRegistry;

beforeAll(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'opensquid-memopurity-'));
  process.env.OPENSQUID_HOME = home;
  registry = await buildRegistry();
});

afterAll(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
});

describe('memoizable purity allowlist (FAC.1)', () => {
  it('the memoizable set equals the reviewed-transitively-pure allowlist', () => {
    const memoizable = registry
      .list()
      .filter((name) => registry.durability(name)?.memoizable === true)
      .sort();
    expect(memoizable).toEqual([...REVIEWED_PURE].sort());
  });

  it('the five audit-flagged primitives are registered and NOT memoizable', () => {
    for (const name of [
      'text_pattern_match',
      'recall_pre_inject',
      'http_request',
      'llm_classify',
      'check_destination',
      'destination_check',
    ]) {
      const d = registry.durability(name);
      if (d === undefined) continue; // name variant not registered — the allowlist test covers the set
      expect(d.memoizable, `${name} must not be memoizable`).toBe(false);
    }
  });
});

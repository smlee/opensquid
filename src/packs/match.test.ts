/** ORCH.3 — matchPacks: most-specific-wins, qualifier-only-matches-when-turn-carries-it, no-match, tie surfaced. */
import { describe, expect, it } from 'vitest';

import { matchPacks } from './match.js';
import { PackV2 } from './schemas/pack_v2.js';
import type { Facets } from '../runtime/classify.js';

const pack = (name: string, serves: unknown): PackV2 =>
  PackV2.parse({ name, version: '1.0.0', scope: 'workflow', serves });

const codingFlow = pack('coding-flow', { intent: 'produce', domain: 'coding' });
const rustFlow = pack('rust-flow', { intent: 'produce', domain: 'coding', lang: 'rust' });
const deepResearch = pack('deep-research', { intent: 'inform' });
const catalog = [codingFlow, rustFlow, deepResearch];

const f = (over: Partial<Facets> & Pick<Facets, 'intent'>): Facets => ({
  project: true,
  confidence: 'high',
  ...over,
});

describe('matchPacks (ORCH.3)', () => {
  it('most-specific wins ONLY when the turn carries the qualifier — else the broader pack is the sole match', () => {
    // turn has no `lang` → rust-flow (3 keys) does NOT match; coding-flow (2 keys) is the sole match.
    const r = matchPacks(f({ intent: 'produce', domain: 'coding' }), catalog);
    expect(r.pack?.name).toBe('coding-flow');
    expect(r.candidates.map((c) => c.name)).toEqual(['coding-flow']);
  });

  it('matches an intent-only pack with a domain wildcard', () => {
    const r = matchPacks(f({ intent: 'inform', domain: 'coding' }), catalog);
    expect(r.pack?.name).toBe('deep-research'); // {inform} matches (domain is a wildcard)
  });

  it('no pack serves the intent → empty candidates, no winner', () => {
    const r = matchPacks(f({ intent: 'converse' }), catalog);
    expect(r.pack).toBeUndefined();
    expect(r.candidates).toEqual([]);
  });

  it('a same-specificity tie surfaces all candidates with no single winner', () => {
    const other = pack('coding-flow-2', { intent: 'produce', domain: 'coding' });
    const r = matchPacks(f({ intent: 'produce', domain: 'coding' }), [codingFlow, other]);
    expect(r.pack).toBeUndefined();
    expect(r.candidates.map((c) => c.name).sort()).toEqual(['coding-flow', 'coding-flow-2']);
  });

  it('hierarchical domain: a deeper serves.domain outranks a shallower one; a shallow turn does not match a deeper pack', () => {
    const frontendFlow = pack('frontend-flow', { intent: 'produce', domain: 'coding.frontend' });
    // a `coding.frontend` turn → both `coding` (depth 1) and `coding.frontend` (depth 2) CONTAIN it; deeper wins.
    const deep = matchPacks(f({ intent: 'produce', domain: 'coding.frontend' }), [codingFlow, frontendFlow]);
    expect(deep.pack?.name).toBe('frontend-flow');
    // a shallow `coding` turn → `coding.frontend` does NOT contain it (graceful depth); coding-flow is sole match.
    const shallow = matchPacks(f({ intent: 'produce', domain: 'coding' }), [codingFlow, frontendFlow]);
    expect(shallow.pack?.name).toBe('coding-flow');
    expect(shallow.candidates.map((c) => c.name)).toEqual(['coding-flow']);
  });

  it('a pack serving via a list matches on its best block', () => {
    const multi = pack('multi', [
      { intent: 'produce', domain: 'coding' },
      { intent: 'transform', domain: 'coding', stakes: 'high' },
    ]);
    expect(
      matchPacks(f({ intent: 'transform', domain: 'coding', stakes: 'high' }), [multi]).pack?.name,
    ).toBe('multi');
    expect(matchPacks(f({ intent: 'produce', domain: 'coding' }), [multi]).pack?.name).toBe(
      'multi',
    );
    expect(matchPacks(f({ intent: 'inform' }), [multi]).candidates).toEqual([]);
  });
});

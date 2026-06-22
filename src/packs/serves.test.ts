/** ORCH.1 — `serves` schema + helpers: parse forms, closed-enum rejects, additive proof, normalize/flatten. */
import { describe, expect, it } from 'vitest';

import { PackV2 } from './schemas/pack_v2.js';
import type { ServesBlock } from './schemas/pack_v2.js';
import { normalizeServes, servesFacets } from './serves.js';

/** A minimal valid v2 pack (no `serves`) — the additive baseline. */
const base = {
  name: 'p',
  version: '1.0.0',
  scope: 'workflow' as const,
};

describe('serves schema (ORCH.1)', () => {
  it('parses a single block, with a free qualifier', () => {
    const p = PackV2.parse({
      ...base,
      serves: { intent: 'produce', domain: 'coding', lang: 'rust' },
    });
    expect(p.serves).toEqual({ intent: 'produce', domain: 'coding', lang: 'rust' });
  });

  it('parses a non-empty list of blocks', () => {
    const p = PackV2.parse({
      ...base,
      serves: [
        { intent: 'produce', domain: 'coding' },
        { intent: 'transform', domain: 'coding', stakes: 'high' },
      ],
    });
    expect(Array.isArray(p.serves)).toBe(true);
    expect((p.serves as ServesBlock[]).length).toBe(2);
  });

  it('rejects a missing intent', () => {
    expect(() => PackV2.parse({ ...base, serves: { domain: 'coding' } })).toThrow();
  });

  it('rejects an intent outside the frozen enum', () => {
    expect(() => PackV2.parse({ ...base, serves: { intent: 'nope' } })).toThrow();
  });

  it('rejects a domain outside the closed dictionary (the anti-invention guarantee)', () => {
    expect(() =>
      PackV2.parse({ ...base, serves: { intent: 'produce', domain: 'legal' } }),
    ).toThrow();
  });

  it('rejects an empty serves list', () => {
    expect(() => PackV2.parse({ ...base, serves: [] })).toThrow();
  });

  it('ADDITIVE: a serves-less pack parses unchanged (serves is undefined, no other field altered)', () => {
    const p = PackV2.parse(base);
    expect(p.serves).toBeUndefined();
    expect(p).toMatchObject({ name: 'p', version: '1.0.0', scope: 'workflow' });
  });
});

describe('serves helpers (ORCH.1)', () => {
  it('normalizeServes: undefined → [], block → [block], list → as-is', () => {
    expect(normalizeServes(undefined)).toEqual([]);
    const b: ServesBlock = { intent: 'inform' };
    expect(normalizeServes(b)).toEqual([b]);
    const list: ServesBlock[] = [{ intent: 'produce' }, { intent: 'decide' }];
    expect(normalizeServes(list)).toBe(list);
  });

  it('servesFacets: flattens to a string→string map, dropping undefined optionals', () => {
    expect(servesFacets({ intent: 'produce', domain: 'coding', lang: 'rust' })).toEqual({
      intent: 'produce',
      domain: 'coding',
      lang: 'rust',
    });
    // a bare block flattens to just its intent (no undefined keys leak in)
    expect(servesFacets({ intent: 'inform' })).toEqual({ intent: 'inform' });
  });
});

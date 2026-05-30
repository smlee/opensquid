/**
 * MM.1 — unit tests for the composite-pack include expansion.
 *
 * Covers happy path, semver range satisfaction, depth-cap, cycle
 * detection, missing-include error, dedup semantics, invalid-semver
 * rejection. No I/O; Pack literals constructed inline.
 */
import { describe, expect, it } from 'vitest';

import type { Pack } from '../runtime/types.js';

import {
  CompositeResolutionError,
  MAX_COMPOSITE_DEPTH,
  expandComposites,
} from './composite_resolver.js';

function focusedPack(name: string, version = '1.0.0'): Pack {
  return {
    name,
    version,
    scope: 'workflow',
    goal: `fixture ${name}`,
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [],
    kind: 'focused',
    usage: 'active',
    includes: [],
  };
}

function compositePack(
  name: string,
  includes: { pack_id: string; semver: string }[],
  version = '1.0.0',
): Pack {
  return {
    name,
    version,
    scope: 'workflow',
    goal: `composite ${name}`,
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [],
    kind: 'composite',
    usage: 'active',
    includes,
  };
}

describe('expandComposites — happy path + ordering', () => {
  it('empty pack list → empty list', () => {
    expect(expandComposites([])).toEqual([]);
  });

  it('list of only focused packs → returned unchanged (in input order)', () => {
    const a = focusedPack('a');
    const b = focusedPack('b');
    const c = focusedPack('c');
    expect(expandComposites([a, b, c]).map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('composite + one focused include → composite then focused (composite preserved)', () => {
    const meta = compositePack('meta', [{ pack_id: 'a', semver: '^1.0.0' }]);
    const a = focusedPack('a', '1.5.0');
    const out = expandComposites([meta, a]);
    expect(out.map((p) => p.name)).toEqual(['meta', 'a']);
    expect(out[0]?.kind).toBe('composite');
    expect(out[1]?.kind).toBe('focused');
  });

  it('two composites both include same focused pack → focused appears once (dedup by name)', () => {
    const meta1 = compositePack('meta1', [{ pack_id: 'shared', semver: '^1.0.0' }]);
    const meta2 = compositePack('meta2', [{ pack_id: 'shared', semver: '^1.0.0' }]);
    const shared = focusedPack('shared', '1.2.3');
    const out = expandComposites([meta1, meta2, shared]);
    expect(out.map((p) => p.name)).toEqual(['meta1', 'shared', 'meta2']);
  });
});

describe('expandComposites — error paths', () => {
  it('composite includes non-existent pack → CompositeResolutionError with cause "missing-include"', () => {
    const meta = compositePack('meta', [{ pack_id: 'ghost', semver: '^1.0.0' }]);
    try {
      expandComposites([meta]);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(CompositeResolutionError);
      const err = e as CompositeResolutionError;
      expect(err.cause).toBe('missing-include');
      expect(err.compositePack).toBe('meta');
      expect(err.message).toContain('ghost');
      expect(err.message).toContain('^1.0.0');
    }
  });

  it('composite range not satisfied by registry version → cause "semver-mismatch"', () => {
    const meta = compositePack('meta', [{ pack_id: 'a', semver: '^2.0.0' }]);
    const a = focusedPack('a', '1.0.0');
    try {
      expandComposites([meta, a]);
      expect.fail('expected throw');
    } catch (e) {
      const err = e as CompositeResolutionError;
      expect(err.cause).toBe('semver-mismatch');
      expect(err.message).toContain('1.0.0');
      expect(err.message).toContain('^2.0.0');
    }
  });

  it('composite A → B (composite) → A → cycle "A → B → A"', () => {
    const a = compositePack('a', [{ pack_id: 'b', semver: '^1.0.0' }]);
    const b = compositePack('b', [{ pack_id: 'a', semver: '^1.0.0' }]);
    try {
      expandComposites([a, b]);
      expect.fail('expected throw');
    } catch (e) {
      const err = e as CompositeResolutionError;
      expect(err.cause).toBe('cycle');
      expect(err.message).toContain('a → b → a');
    }
  });

  it('composite includes range "invalid-semver-!" → cause "invalid-semver"', () => {
    const meta = compositePack('meta', [{ pack_id: 'a', semver: 'invalid-semver-!' }]);
    const a = focusedPack('a');
    try {
      expandComposites([meta, a]);
      expect.fail('expected throw');
    } catch (e) {
      const err = e as CompositeResolutionError;
      expect(err.cause).toBe('invalid-semver');
      expect(err.message).toContain('invalid-semver-!');
    }
  });

  it('composite A → B → C → D (depth 4) exceeds cap (3) → cause "depth-exceeded"', () => {
    // a → b → c → d (each a composite including the next; d is the deepest)
    const a = compositePack('a', [{ pack_id: 'b', semver: '^1.0.0' }]);
    const b = compositePack('b', [{ pack_id: 'c', semver: '^1.0.0' }]);
    const c = compositePack('c', [{ pack_id: 'd', semver: '^1.0.0' }]);
    const d = compositePack('d', [{ pack_id: 'e', semver: '^1.0.0' }]);
    const e = focusedPack('e');
    try {
      expandComposites([a, b, c, d, e]);
      expect.fail('expected throw');
    } catch (err) {
      const e2 = err as CompositeResolutionError;
      expect(e2.cause).toBe('depth-exceeded');
      expect(e2.compositePack).toBe('a');
      expect(e2.message).toContain(String(MAX_COMPOSITE_DEPTH));
    }
  });
});

describe('expandComposites — nested composites + back-compat', () => {
  it('depth 2 composite-of-composite expands all the way down', () => {
    const a = compositePack('a', [{ pack_id: 'b', semver: '^1.0.0' }]);
    const b = compositePack('b', [{ pack_id: 'c', semver: '^1.0.0' }]);
    const c = focusedPack('c');
    const out = expandComposites([a, b, c]);
    expect(out.map((p) => p.name)).toEqual(['a', 'b', 'c']);
  });

  it('Pack with undefined kind (test fixture back-compat) treated as focused', () => {
    const pack = { ...focusedPack('a') };
    const packAny = pack as Pack & { kind?: 'focused' | 'composite' };
    delete packAny.kind;
    expect(expandComposites([pack]).map((p) => p.name)).toEqual(['a']);
  });

  it('CompositeResolutionError preserves compositePack + cause for downstream pattern-matching', () => {
    const meta = compositePack('meta', [{ pack_id: 'ghost', semver: '^1.0.0' }]);
    try {
      expandComposites([meta]);
      expect.fail();
    } catch (e) {
      expect(e).toBeInstanceOf(CompositeResolutionError);
      expect((e as CompositeResolutionError).name).toBe('CompositeResolutionError');
      expect((e as CompositeResolutionError).compositePack).toBe('meta');
      expect((e as CompositeResolutionError).cause).toBe('missing-include');
    }
  });
});

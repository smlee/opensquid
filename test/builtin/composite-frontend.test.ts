/**
 * DOG.2 — frontend-react-19-atomic composite-pack integration tests.
 *
 * Verifies the composite manifest loads with `kind: composite` + 3-entry
 * `includes:`, that composite_resolver expands the composite into a flat
 * list containing all 3 children, that the standard composite error paths
 * (missing include, semver mismatch) raise CompositeResolutionError, and
 * that each child's `detected_by` continues to fire independently after
 * expansion (i.e. composite expansion is purely registry-flattening — it
 * does NOT aggregate or short-circuit child detection).
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CompositeResolutionError, expandComposites } from '../../src/packs/composite_resolver.js';
import { loadPack } from '../../src/packs/loader.js';
import { matchesDetectedBy, type DetectionContext } from '../../src/runtime/detection.js';
import type { Pack } from '../../src/runtime/types.js';

const COMPOSITE_NAME = 'frontend-react-19-atomic';
const CHILD_NAMES = [
  'focused-react-19',
  'focused-typescript-strict',
  'focused-atomic-design',
] as const;

function emptyCtx(): DetectionContext {
  return {
    cwd: '/tmp/proj',
    files: {},
    dirs: {},
    fileContents: {},
    memoryBodies: '',
    recentPrompts: '',
    userPinned: false,
  };
}

async function loadAllForRegistry(): Promise<Pack[]> {
  const composite = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
  const children = await Promise.all(CHILD_NAMES.map((n) => loadPack(resolve('packs/builtin', n))));
  return [composite, ...children];
}

describe('DOG.2 — frontend-react-19-atomic composite pack', () => {
  it('loads via loadPack() with kind: composite + 3-entry includes', async () => {
    const pack = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    expect(pack.name).toBe(COMPOSITE_NAME);
    expect(pack.kind).toBe('composite');
    expect(pack.includes).toHaveLength(3);
    expect(pack.includes?.map((i) => i.pack_id)).toEqual([...CHILD_NAMES]);
  });

  it('composite has NO own foundation (pure aggregator per v0.6 §4.7)', async () => {
    const pack = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    expect(pack.foundation).toBeUndefined();
  });

  it('composite has empty detected_by (children gate themselves)', async () => {
    const pack = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    expect(pack.detectedBy).toEqual([]);
  });

  it('composite carries no own skills (composites contribute zero skills)', async () => {
    const pack = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    expect(pack.skills).toEqual([]);
  });

  it('expandComposites produces 4 packs (composite + 3 children) when registry has all', async () => {
    const registry = await loadAllForRegistry();
    const expanded = expandComposites(registry);
    expect(expanded.map((p) => p.name)).toEqual([COMPOSITE_NAME, ...CHILD_NAMES]);
  });

  it('expandComposites is idempotent — expanding twice yields the same flat list', async () => {
    const registry = await loadAllForRegistry();
    const once = expandComposites(registry);
    const twice = expandComposites(once);
    expect(twice.map((p) => p.name)).toEqual(once.map((p) => p.name));
  });

  it('expandComposites throws CompositeResolutionError when a child is missing from the registry', async () => {
    const composite = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    const partial = [composite, await loadPack(resolve('packs/builtin/focused-react-19'))];
    expect(() => expandComposites(partial)).toThrow(CompositeResolutionError);
    expect(() => expandComposites(partial)).toThrow(/missing|no pack with that name/i);
  });

  it('expandComposites throws on semver mismatch (child version does NOT satisfy include range)', async () => {
    const composite = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    // Forge a "registry" where the children are present but at a version far
    // below the >=0.1.0 range — synthesize via a shallow clone so we don't
    // mutate the loaded packs (Pack is data-only per apply_extends.ts).
    const childAtBadVersion = await loadPack(resolve('packs/builtin/focused-react-19'));
    const downgraded: Pack = { ...childAtBadVersion, version: '0.0.1' };
    const sibling1 = await loadPack(resolve('packs/builtin/focused-typescript-strict'));
    const sibling2 = await loadPack(resolve('packs/builtin/focused-atomic-design'));
    const registry: Pack[] = [composite, downgraded, sibling1, sibling2];
    expect(() => expandComposites(registry)).toThrow(CompositeResolutionError);
    expect(() => expandComposites(registry)).toThrow(/0\.0\.1.*does NOT satisfy|semver/i);
  });

  it('each child detected_by fires independently against synthetic DetectionContext after expansion', async () => {
    const registry = await loadAllForRegistry();
    const expanded = expandComposites(registry);
    const r19 = expanded.find((p) => p.name === 'focused-react-19')!;
    const ts = expanded.find((p) => p.name === 'focused-typescript-strict')!;
    const ad = expanded.find((p) => p.name === 'focused-atomic-design')!;

    const reactCtx: DetectionContext = {
      ...emptyCtx(),
      files: { 'package.json': true, 'tsconfig.json': true },
      dirs: { 'src/components/atoms': true },
      fileContents: {
        'package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      },
    };

    expect(matchesDetectedBy(r19.detectedBy ?? [], reactCtx)).toBe(true);
    expect(matchesDetectedBy(ts.detectedBy ?? [], reactCtx)).toBe(true);
    expect(matchesDetectedBy(ad.detectedBy ?? [], reactCtx)).toBe(true);
  });

  it('all 3 children return false on empty DetectionContext (no spurious activations)', async () => {
    // Composite itself has empty detected_by, which is vacuously true per
    // matchesDetectedBy contract (a pack with no rules is always-active).
    // The children, however, all carry non-empty detected_by — they MUST NOT
    // fire against an empty context.
    const registry = await loadAllForRegistry();
    const expanded = expandComposites(registry);
    for (const childName of CHILD_NAMES) {
      const child = expanded.find((p) => p.name === childName)!;
      const fires = matchesDetectedBy(child.detectedBy ?? [], emptyCtx());
      expect(fires, `child ${childName} should NOT activate on empty ctx`).toBe(false);
    }
  });

  it('composite with empty detected_by is vacuously active (matchesDetectedBy contract)', async () => {
    const pack = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    expect(matchesDetectedBy(pack.detectedBy ?? [], emptyCtx())).toBe(true);
  });

  it('composite-only registry (no children) still throws missing-include error pointing at first missing child', async () => {
    const composite = await loadPack(resolve('packs/builtin', COMPOSITE_NAME));
    expect(() => expandComposites([composite])).toThrow(CompositeResolutionError);
    expect(() => expandComposites([composite])).toThrow(/focused-react-19/);
  });
});

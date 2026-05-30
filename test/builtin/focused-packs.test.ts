/**
 * DOG.1 — focused pack load + manifest-shape tests.
 *
 * Verifies the 3 new focused packs (react-19, typescript-strict, atomic-design)
 * load via loadPack + carry the expected foundation + detected_by shape.
 * Also exercises matchesDetectedBy with synthetic DetectionContext to
 * verify the activation regex/glob patterns actually fire.
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { matchesDetectedBy, type DetectionContext } from '../../src/runtime/detection.js';

const PACKS = ['focused-react-19', 'focused-typescript-strict', 'focused-atomic-design'] as const;

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

describe('DOG.1 — focused packs load + carry expected manifest fields', () => {
  for (const name of PACKS) {
    it(`${name} loads via loadPack() without error + has scope: domain`, async () => {
      const pack = await loadPack(resolve('packs/builtin', name));
      expect(pack.name).toBe(name);
      expect(pack.scope).toBe('domain');
      expect(pack.activationScope).toBe('project');
      expect(pack.detectedBy).toBeDefined();
      expect((pack.detectedBy ?? []).length).toBeGreaterThan(0);
      expect(pack.foundation).toBeDefined();
    });
  }

  it('focused-react-19 carries react@>=19 in foundation.tools + react methodologies', async () => {
    const pack = await loadPack(resolve('packs/builtin/focused-react-19'));
    expect(pack.foundation?.tools).toContainEqual({ name: 'react', semver: '>=19' });
    expect(pack.foundation?.domains).toContain('frontend');
    expect(pack.foundation?.methodologies).toContain('server-components');
  });

  it('focused-typescript-strict carries typescript@>=5 + strict-mode methodology', async () => {
    const pack = await loadPack(resolve('packs/builtin/focused-typescript-strict'));
    expect(pack.foundation?.tools).toContainEqual({ name: 'typescript', semver: '>=5' });
    expect(pack.foundation?.methodologies).toContain('strict-mode');
  });

  it('focused-atomic-design carries no tool requirement (methodology pack)', async () => {
    const pack = await loadPack(resolve('packs/builtin/focused-atomic-design'));
    expect(pack.foundation?.tools).toEqual([]);
    expect(pack.foundation?.methodologies).toContain('atomic-design');
  });

  it('focused-react-19 activates on package.json with react ^19 in dependencies', async () => {
    const pack = await loadPack(resolve('packs/builtin/focused-react-19'));
    const ctx: DetectionContext = {
      ...emptyCtx(),
      files: { 'package.json': true },
      fileContents: {
        'package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      },
    };
    expect(matchesDetectedBy(pack.detectedBy ?? [], ctx)).toBe(true);
  });

  it('focused-react-19 does NOT activate on react ^17', async () => {
    const pack = await loadPack(resolve('packs/builtin/focused-react-19'));
    const ctx: DetectionContext = {
      ...emptyCtx(),
      files: { 'package.json': true },
      fileContents: {
        'package.json': JSON.stringify({ dependencies: { react: '^17.0.0' } }),
      },
    };
    expect(matchesDetectedBy(pack.detectedBy ?? [], ctx)).toBe(false);
  });

  it('focused-atomic-design activates on src/components/atoms dir present', async () => {
    const pack = await loadPack(resolve('packs/builtin/focused-atomic-design'));
    const ctx: DetectionContext = {
      ...emptyCtx(),
      dirs: { 'src/components/atoms': true },
    };
    expect(matchesDetectedBy(pack.detectedBy ?? [], ctx)).toBe(true);
  });

  it('all 3 packs return false on empty DetectionContext', async () => {
    for (const name of PACKS) {
      const pack = await loadPack(resolve('packs/builtin', name));
      expect(matchesDetectedBy(pack.detectedBy ?? [], emptyCtx())).toBe(false);
    }
  });

  it('focused-typescript-strict activates when tsconfig.json exists', async () => {
    const pack = await loadPack(resolve('packs/builtin/focused-typescript-strict'));
    const ctx: DetectionContext = {
      ...emptyCtx(),
      files: { 'tsconfig.json': true },
    };
    expect(matchesDetectedBy(pack.detectedBy ?? [], ctx)).toBe(true);
  });
});

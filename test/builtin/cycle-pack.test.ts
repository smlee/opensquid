/**
 * E2E test for the built-in cycle-pack (Task 7.6).
 *
 * Acceptance per phase-7-wedge-gate.md §"Task 7.6":
 *  - Pack folder + 3 files present.
 *  - Pack loads cleanly via the Phase 2 loader.
 *  - Skill is preload + universal scope.
 *
 * Lives under test/builtin/ (vitest's default discovery covers src/ + test/
 * + scripts/ — see `vitest.config.ts`). The pack itself ships from
 * packs/builtin/cycle-pack/ (in `package.json`'s `files`). We resolve the
 * pack path relative to the repo root (process.cwd()) so the test works
 * from the repo regardless of where it's invoked.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';

describe('builtin cycle-pack', () => {
  it('loads cleanly via loadPack', async () => {
    const pack = await loadPack(resolve('packs/builtin/cycle-pack'));
    expect(pack.name).toBe('cycle-pack');
    expect(pack.scope).toBe('universal');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pack.goal).toMatch(/wedge gate/i);
  });

  it('ships a single preload skill — lesson-capture', async () => {
    const pack = await loadPack(resolve('packs/builtin/cycle-pack'));
    expect(pack.skills).toHaveLength(1);
    const skill = pack.skills[0];
    expect(skill?.name).toBe('lesson-capture');
    expect(skill?.load).toBe('preload');
    expect(skill?.when_to_load).toEqual([{ kind: 'event_type', type: 'prompt_submit' }]);
  });

  it('declares a triage rule that emits a pass verdict when the classifier returns NONE', async () => {
    const pack = await loadPack(resolve('packs/builtin/cycle-pack'));
    const skill = pack.skills[0];
    expect(skill?.rules).toHaveLength(1);
    const rule = skill?.rules[0];
    expect(rule?.id).toBe('triage');
    expect(rule?.kind).toBe('track_check');
    // The track-check rule has a `process` array.
    if (rule?.kind !== 'track_check') throw new Error('expected track_check rule');
    expect(rule.process.length).toBeGreaterThanOrEqual(2);
    // First step is the classifier call.
    expect(rule.process[0]?.call).toBe('llm_classify');
    // Second step is the verdict gate.
    expect(rule.process[1]?.call).toBe('verdict');
    expect(rule.process[1]?.if).toMatch(/NONE/);
  });
});

/**
 * E2E test for the built-in sangmin-personal pack (PERS.2).
 *
 * Acceptance per docs/tasks/personal-pack.md PERS.2:
 *  - Pack folder + side-files present.
 *  - Pack loads cleanly via the Phase 2 loader.
 *  - validateUniqueSkillNames passes (no skill name collisions).
 *  - validatePackFunctions passes against the runtime registry (every
 *    `call:` resolves to a registered primitive).
 *  - Six skill folders (git, engine-vocab, workflow, versioning,
 *    honesty-ledger, phase-logging).
 *
 * The pack ships from packs/builtin/sangmin-personal/ (in package.json's
 * `files`). We resolve the path relative to process.cwd() so the test
 * runs from the repo regardless of invocation directory.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { validatePackFunctions } from '../../src/packs/validate_functions.js';
import { validateUniqueSkillNames } from '../../src/packs/validate_uniqueness.js';
import { buildRegistry } from '../../src/runtime/bootstrap.js';

describe('builtin sangmin-personal pack', () => {
  it('loads cleanly via loadPack', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    expect(pack.name).toBe('sangmin-personal');
    expect(pack.scope).toBe('universal');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pack.goal).toMatch(/verified work/i);
    expect(pack.evolves).toBe(true);
  });

  it('ships six skill folders', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    const skillNames = pack.skills.map((s) => s.name).sort();
    expect(skillNames).toEqual([
      'engine-vocab',
      'git',
      'honesty-ledger',
      'phase-logging',
      'versioning',
      'workflow',
    ]);
  });

  it('passes validateUniqueSkillNames (no in-pack collisions)', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    const issues = validateUniqueSkillNames([pack]);
    expect(issues).toEqual([]);
  });

  it('every process step references a registered primitive', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    // Inject a no-op RAG backend so the test doesn't try to spawn a live
    // loop-engine daemon (T.3 wired RAG; resolveBackendConfig() defaults
    // to loop-engine when the binary is discoverable). Registry shape is
    // independent of which backend services the calls — validatePackFunctions
    // only checks primitive names are registered.
    const registry = await buildRegistry({
      backend: {
        init: () => Promise.resolve(),
        embed: () => Promise.resolve(null),
        recall: () => Promise.resolve([]),
        storeLesson: () => Promise.resolve(),
      },
    });
    const issues = validatePackFunctions(pack, registry);
    expect(issues).toEqual([]);
  });

  it('declares git skill with the three locked block-tool rules', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    const git = pack.skills.find((s) => s.name === 'git');
    expect(git).toBeDefined();
    const ruleIds = git?.rules.map((r) => r.id).sort();
    expect(ruleIds).toEqual(['never-amend', 'no-force-push-main', 'no-implicit-push']);
    expect(git?.load).toBe('lazy');
  });

  it('declares workflow skill with a destination_check + track_check pair', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    const workflow = pack.skills.find((s) => s.name === 'workflow');
    expect(workflow).toBeDefined();
    expect(workflow?.load).toBe('preload');
    const kinds = workflow?.rules.map((r) => r.kind).sort();
    expect(kinds).toEqual(['destination_check', 'track_check']);
  });

  it('declares honesty-ledger with fourteen claim rules', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    const ledger = pack.skills.find((s) => s.name === 'honesty-ledger');
    expect(ledger?.rules).toHaveLength(14);
    expect(ledger?.load).toBe('preload');
  });

  it('declares phase-logging with three claim rules', async () => {
    const pack = await loadPack(resolve('packs/builtin/sangmin-personal'));
    const phaseLogging = pack.skills.find((s) => s.name === 'phase-logging');
    expect(phaseLogging?.rules).toHaveLength(3);
    expect(phaseLogging?.load).toBe('preload');
  });
});

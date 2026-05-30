/**
 * E2E test for the built-in default-discipline pack.
 *
 * Renamed from `sangmin-personal` per T-BUILTIN-RETIRE BR.1 (2026-05-29):
 * the previous name implied personal content despite the pack carrying
 * generic drift-gate discipline. Authoritative source:
 * docs/tasks/T-builtin-retire.md.
 *
 * Acceptance:
 *  - Pack folder + side-files present.
 *  - Pack loads cleanly via the Phase 2 loader.
 *  - validateUniqueSkillNames passes (no skill name collisions).
 *  - validatePackFunctions passes against the runtime registry (every
 *    `call:` resolves to a registered primitive).
 *  - Seven skill folders (d9-guard, engine-vocab, git, honesty-ledger,
 *    phase-logging, versioning, workflow).
 *
 * The pack ships from packs/builtin/default-discipline/ (in package.json's
 * `files`). We resolve the path relative to process.cwd() so the test
 * runs from the repo regardless of invocation directory.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { validatePackFunctions } from '../../src/packs/validate_functions.js';
import { validateUniqueSkillNames } from '../../src/packs/validate_uniqueness.js';
import { buildRegistry } from '../../src/runtime/bootstrap.js';

describe('builtin default-discipline pack', () => {
  it('loads cleanly via loadPack', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    expect(pack.name).toBe('default-discipline');
    expect(pack.scope).toBe('universal');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pack.goal).toMatch(/verified work/i);
    expect(pack.evolves).toBe(true);
  });

  it('ships eight skill folders (LL.5 added inbound-greeter)', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const skillNames = pack.skills.map((s) => s.name).sort();
    expect(skillNames).toEqual([
      'd9-guard',
      'engine-vocab',
      'git',
      'honesty-ledger',
      'inbound-greeter',
      'phase-logging',
      'versioning',
      'workflow',
    ]);
  });

  it('passes validateUniqueSkillNames (no in-pack collisions)', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const issues = validateUniqueSkillNames([pack]);
    expect(issues).toEqual([]);
  });

  it('every process step references a registered primitive', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
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
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const git = pack.skills.find((s) => s.name === 'git');
    expect(git).toBeDefined();
    const ruleIds = git?.rules.map((r) => r.id).sort();
    expect(ruleIds).toEqual(['never-amend', 'no-force-push-main', 'no-implicit-push']);
    expect(git?.load).toBe('lazy');
  });

  it('declares workflow skill with a destination_check + track_check pair', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const workflow = pack.skills.find((s) => s.name === 'workflow');
    expect(workflow).toBeDefined();
    expect(workflow?.load).toBe('preload');
    const kinds = workflow?.rules.map((r) => r.kind).sort();
    expect(kinds).toEqual(['destination_check', 'track_check']);
  });

  it('declares honesty-ledger with fourteen claim rules', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const ledger = pack.skills.find((s) => s.name === 'honesty-ledger');
    expect(ledger?.rules).toHaveLength(14);
    expect(ledger?.load).toBe('preload');
  });

  it('declares phase-logging with three claim rules', async () => {
    const pack = await loadPack(resolve('packs/builtin/default-discipline'));
    const phaseLogging = pack.skills.find((s) => s.name === 'phase-logging');
    expect(phaseLogging?.rules).toHaveLength(3);
    expect(phaseLogging?.load).toBe('preload');
  });
});

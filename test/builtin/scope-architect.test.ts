/**
 * E2E test for the built-in scope-architect pack.
 *
 * Per T-DISCIPLINE-PIPELINE-COMPLETION DPC.1 (2026-05-30): promotes the
 * user-pack scope-decomposer's 7 rules into a built-in pack split as 6
 * skills. Verifies pack loads, all skills present, all primitive refs
 * resolve, manifest fields correct.
 *
 * Source: docs/tasks/T-discipline-pipeline-completion.md DPC.1 acceptance
 * criteria.
 */

import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { validatePackFunctions } from '../../src/packs/validate_functions.js';
import { validateUniqueSkillNames } from '../../src/packs/validate_uniqueness.js';
import { buildRegistry } from '../../src/runtime/bootstrap.js';

describe('builtin scope-architect pack', () => {
  it('loads cleanly via loadPack', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    expect(pack.name).toBe('scope-architect');
    expect(pack.scope).toBe('universal');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pack.goal).toMatch(/scope-first/i);
    expect(pack.evolves).toBe(true);
  });

  it('ships six skills (one per rule kind)', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const skillNames = pack.skills.map((s) => s.name).sort();
    expect(skillNames).toEqual([
      'chain-handoffs',
      'inline-spec-block',
      'scope-before-code',
      'scope-detect',
      'task-list-generated',
      'taskcreate-spec-required',
    ]);
  });

  it('passes validateUniqueSkillNames (no in-pack collisions)', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const issues = validateUniqueSkillNames([pack]);
    expect(issues).toEqual([]);
  });

  it('every process step references a registered primitive', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
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

  it('scope-detect skill fires on prompt_submit triggers', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const skill = pack.skills.find((s) => s.name === 'scope-detect');
    expect(skill).toBeDefined();
    expect(skill?.triggers.map((t) => t.kind)).toContain('prompt_submit');
  });

  it('chain-handoffs skill declares chain_stage requires per rule', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const skill = pack.skills.find((s) => s.name === 'chain-handoffs');
    expect(skill).toBeDefined();
    const ruleIds = skill?.rules.map((r) => r.id).sort();
    expect(ruleIds).toEqual([
      'chain-handoff-research-to-spec',
      'chain-handoff-resume-phases',
      'chain-handoff-spec-to-tasks',
    ]);
  });
});

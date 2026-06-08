/**
 * MM.4 — pack-architect built-in profession pack load + skill-shape tests.
 *
 * Following the test/builtin/scope-architect.test.ts pattern: assert pack
 * loads via loadPack, exposes the expected kind/usage/team shape, and each
 * of the 3 skills is well-formed (correct name + trigger kind + verdict
 * level).
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { validatePackFunctions } from '../../src/packs/validate_functions.js';
import { validateUniqueSkillNames } from '../../src/packs/validate_uniqueness.js';
import { buildRegistry } from '../../src/runtime/bootstrap.js';

describe('builtin pack-architect pack (T-MULTIMODE MM.4)', () => {
  it('loads cleanly via loadPack', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    expect(pack.name).toBe('pack-architect');
    expect(pack.scope).toBe('workflow');
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pack.goal).toMatch(/teach pack authoring/i);
  });

  it('declares kind: focused + usage: both + activation_scope: user', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    expect(pack.kind).toBe('focused');
    expect(pack.usage).toBe('both');
    expect(pack.includes).toEqual([]);
    expect(pack.activationScope).toBe('user');
    expect(pack.detectedBy).toEqual([]);
  });

  it('team.yaml has exactly one pack-architect role with PACK_AUTHORING_COMPLETE handoff', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    expect(pack.team).toBeDefined();
    expect(pack.team?.name).toBe('pack-architect-team');
    expect(pack.team?.roles).toHaveLength(1);
    const role = pack.team?.roles[0];
    expect(role?.name).toBe('pack-architect');
    expect(role?.pack).toBe('pack-architect');
    expect(role?.model_alias).toBe('reasoning');
    expect(role?.handoff_signal).toBe('PACK_AUTHORING_COMPLETE');
    expect(role?.instructions).toMatch(/4-phase workflow/);
  });

  it('ships 4 skills (incl. fsm-author-walkthrough for FSM/behavior packs)', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    const names = pack.skills.map((s) => s.name).sort();
    expect(names).toEqual([
      'fsm-author-walkthrough',
      'manifest-author-walkthrough',
      'pack-scope-elicit',
      'skill-yaml-author-walkthrough',
    ]);
  });

  it('pack-scope-elicit emits directive to scope-architect', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    const skill = pack.skills.find((s) => s.name === 'pack-scope-elicit');
    expect(skill?.triggers).toContainEqual({ kind: 'prompt_submit' });
    const rule = skill?.rules[0];
    expect(rule?.id).toBe('detect-pack-authoring-intent-without-scope');
    const verdictStep = (rule?.kind === 'track_check' ? rule.process : [])?.find(
      (s) => (s as { call?: string }).call === 'verdict',
    );
    const args = (verdictStep as { args?: Record<string, unknown> })?.args ?? {};
    expect(args.level).toBe('directive');
    const nextAction = args.next_action as { profession?: string } | undefined;
    expect(nextAction?.profession).toBe('scope-architect');
  });

  it('manifest-author-walkthrough emits surface verdict for packs/*/manifest.yaml', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    const skill = pack.skills.find((s) => s.name === 'manifest-author-walkthrough');
    expect(skill?.triggers).toContainEqual({ kind: 'tool_call' });
    const rule = skill?.rules[0];
    expect(rule?.id).toBe('surface-manifest-authoring-checklist');
  });

  it('skill-yaml-author-walkthrough emits surface verdict for packs/*/skills/*/skill.yaml', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    const skill = pack.skills.find((s) => s.name === 'skill-yaml-author-walkthrough');
    expect(skill?.triggers).toContainEqual({ kind: 'tool_call' });
    const rule = skill?.rules[0];
    expect(rule?.id).toBe('surface-skill-yaml-authoring-checklist');
  });

  it('no vendor model names as actual model identifiers', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    const haystack = JSON.stringify(pack);
    // Catches vendor-shaped model ids (claude-haiku-..., gpt-4..., etc.)
    // but allows memory-citation prose like "feedback_stop_haiku_drift".
    expect(haystack).not.toMatch(/claude-(?:haiku|sonnet|opus)-\d/i);
    expect(haystack).not.toMatch(/\bgpt-\d/i);
    expect(haystack).not.toMatch(/\bo[1-9]-(?:mini|preview)\b/i);
    // The team.yaml's model_alias must be the abstract "reasoning" alias
    // (not a vendor name).
    expect(pack.team?.roles[0]?.model_alias).toBe('reasoning');
  });

  it('every process step references a registered primitive', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    const registry = await buildRegistry({
      backend: {
        init: () => Promise.resolve(),
        embed: () => Promise.resolve(null),
        recall: () => Promise.resolve([]),
        storeLesson: () => Promise.resolve(),
        deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
      },
    });
    const issues = validatePackFunctions(pack, registry);
    expect(issues).toEqual([]);
  });

  it('passes validateUniqueSkillNames (no in-pack collisions)', async () => {
    const pack = await loadPack(resolve('packs/builtin/pack-architect'));
    expect(validateUniqueSkillNames([pack])).toEqual([]);
  });
});

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

  it('ships eight skills (recall-consumed removed in SG.3)', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const skillNames = pack.skills.map((s) => s.name).sort();
    expect(skillNames).toEqual([
      'chain-handoffs',
      'inline-spec-block',
      'pack-skill-authoring',
      'pre-research-authoring',
      'scope-before-code',
      'scope-detect',
      'task-list-generated',
      'taskcreate-spec-required',
    ]);
  });
  // SG.3 (2026-06-01): recall-consumed removed — it was unsound at the Stop
  // hook (off-by-one read of the triggering response + non-resetting trigger
  // → 9× loop) and gated an unverifiable predicate. Response-judging gates
  // belong at UserPromptSubmit, not Stop. See docs/tasks/T-scope-gates.md SG.3.

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

  // ----- DPC.2 (2026-05-30) — behavioral test for widened regex coverage -----
  // Each "fire" prompt must match at least one pattern; each "silent" prompt
  // must match zero. The test inspects the patterns directly (no full
  // dispatcher fire) — fast + deterministic.
  it('DPC.2: scope-detect patterns fire on drift-transcript prompts', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const skill = pack.skills.find((s) => s.name === 'scope-detect');
    const rule = skill?.rules[0];
    if (rule?.kind !== 'track_check') throw new Error('expected track_check rule');
    const step = rule.process[0];
    expect(step?.call).toBe('text_pattern_match');
    const patterns = (step?.args?.patterns as string[]) ?? [];

    const fireCases = [
      'yes audit and add a proper solution to the existing batch of todos we have',
      'place a refactor based on it all',
      'close the gaps based your understanding',
      'fix the items',
      'audit memory entries for drift',
      'spec out the next track',
    ];
    for (const prompt of fireCases) {
      const matched = patterns.filter((pat) => new RegExp(pat).test(prompt));
      expect(matched.length, `expected fire on: "${prompt}"`).toBeGreaterThan(0);
    }
  });

  it('DPC.2: scope-detect patterns stay silent on unrelated prompts', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const skill = pack.skills.find((s) => s.name === 'scope-detect');
    const rule = skill?.rules[0];
    if (rule?.kind !== 'track_check') throw new Error('expected track_check rule');
    const step = rule.process[0];
    const patterns = (step?.args?.patterns as string[]) ?? [];

    const silentCases = ['random unrelated chat about lunch', 'what is the time'];
    for (const prompt of silentCases) {
      const matched = patterns.filter((pat) => new RegExp(pat).test(prompt));
      expect(matched.length, `expected silent on: "${prompt}"`).toBe(0);
    }
  });

  it('MM.3: loads with kind: focused + usage: both', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    expect(pack.kind).toBe('focused');
    expect(pack.usage).toBe('both');
    expect(pack.includes).toEqual([]);
  });

  it('MM.3: team.yaml loads with exactly one scope-architect role', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    expect(pack.team).toBeDefined();
    expect(pack.team?.name).toBe('scope-architect-team');
    expect(pack.team?.roles).toHaveLength(1);
    const role = pack.team?.roles[0];
    expect(role?.name).toBe('scope-architect');
    expect(role?.pack).toBe('scope-architect');
    expect(role?.model_alias).toBe('reasoning');
    expect(role?.handoff_signal).toBe('SCOPE_COMPLETE');
    expect(role?.instructions).toMatch(/scope-architect subagent/);
  });

  it('MM.3: model_alias is not a vendor model name', async () => {
    const pack = await loadPack(resolve('packs/builtin/scope-architect'));
    const alias = pack.team?.roles[0]?.model_alias ?? '';
    expect(alias).not.toMatch(/haiku|sonnet|opus|gpt-|claude-|anthropic|openai/i);
  });
});

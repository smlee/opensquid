/**
 * Tests for `partitionSkills` — pinned-skill semantics (Phase 3 Task 3.5).
 *
 * Coverage matrix (5 cases):
 *   1. Universal + preload → pinned.
 *   2. Workflow + preload → dynamic (scope is the disqualifier).
 *   3. Universal + lazy   → dynamic (load mode is the disqualifier).
 *   4. Universal + preload + non-empty `unloads_when` → pinned AND a
 *      stderr warning is emitted.
 *   5. Mixed packs — partition splits correctly across packs and across
 *      skills inside each pack.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { partitionSkills } from './pinned_skills.js';
import type { Pack, Scope, Skill } from './types.js';
import type { LoadMode } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function makeSkill(name: string, load: LoadMode, opts: { unloads_when?: unknown[] } = {}): Skill {
  return {
    name,
    load,
    when_to_load: [],
    unloads_when: opts.unloads_when ?? [],
    rules: [],
  };
}

function makePack(name: string, scope: Scope, skills: Skill[]): Pack {
  return {
    name,
    version: '0.0.1',
    scope,
    goal: 'test',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Universal + preload → pinned.
// ---------------------------------------------------------------------------

describe('partitionSkills — universal + preload', () => {
  it('pins a universal-scope preload skill', () => {
    const pack = makePack('user-codex', 'universal', [makeSkill('always-on', 'preload')]);
    const { pinned, dynamic } = partitionSkills([pack]);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.skill.name).toBe('always-on');
    expect(pinned[0]!.pack).toBe(pack);
    expect(dynamic).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Workflow + preload → dynamic. Scope is the disqualifier.
// ---------------------------------------------------------------------------

describe('partitionSkills — workflow + preload is dynamic', () => {
  it('does NOT pin a preload skill on a workflow-scope pack', () => {
    const pack = makePack('git-flow', 'workflow', [makeSkill('on-activate', 'preload')]);
    const { pinned, dynamic } = partitionSkills([pack]);
    expect(pinned).toHaveLength(0);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]!.skill.name).toBe('on-activate');
  });
});

// ---------------------------------------------------------------------------
// 3. Universal + lazy → dynamic. Load mode is the disqualifier.
// ---------------------------------------------------------------------------

describe('partitionSkills — universal + lazy is dynamic', () => {
  it('does NOT pin a lazy skill even on a universal-scope pack', () => {
    const pack = makePack('user-codex', 'universal', [makeSkill('on-match', 'lazy')]);
    const { pinned, dynamic } = partitionSkills([pack]);
    expect(pinned).toHaveLength(0);
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]!.skill.name).toBe('on-match');
  });
});

// ---------------------------------------------------------------------------
// 4. Universal + preload + unloads_when → still pinned + stderr warning.
// ---------------------------------------------------------------------------

describe('partitionSkills — pinned skill with contradictory unloads_when', () => {
  it('emits a stderr warning AND still pins the skill', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pack = makePack('user-codex', 'universal', [
      makeSkill('contradictory', 'preload', {
        unloads_when: [{ kind: 'idle_for', minutes: 10 }],
      }),
    ]);

    const { pinned, dynamic } = partitionSkills([pack]);

    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.skill.name).toBe('contradictory');
    expect(dynamic).toHaveLength(0);

    // Warning emitted to stderr, mentioning both names.
    expect(errSpy).toHaveBeenCalledTimes(1);
    const warning = String(errSpy.mock.calls[0]![0]);
    expect(warning).toContain('user-codex');
    expect(warning).toContain('contradictory');
    expect(warning.toLowerCase()).toContain('warning');
  });

  it('does NOT warn when a pinned skill has an empty unloads_when array', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const pack = makePack('user-codex', 'universal', [makeSkill('clean-pin', 'preload')]);
    const { pinned } = partitionSkills([pack]);
    expect(pinned).toHaveLength(1);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Mixed packs — partition splits correctly across scopes + load modes.
// ---------------------------------------------------------------------------

describe('partitionSkills — mixed packs', () => {
  it('splits skills across multiple packs into the correct buckets', () => {
    const userCodex = makePack('user-codex', 'universal', [
      makeSkill('pin-1', 'preload'), // pinned
      makeSkill('lazy-1', 'lazy'), // dynamic
    ]);
    const workflow = makePack('git-flow', 'workflow', [
      makeSkill('preload-not-pinned', 'preload'), // dynamic (workflow scope)
      makeSkill('lazy-2', 'lazy'), // dynamic
    ]);
    const project = makePack('repo-x', 'project', [
      makeSkill('preload-project', 'preload'), // dynamic
    ]);

    const { pinned, dynamic } = partitionSkills([userCodex, workflow, project]);

    expect(pinned.map((p) => p.skill.name)).toEqual(['pin-1']);
    expect(dynamic.map((d) => d.skill.name).sort()).toEqual(
      ['lazy-1', 'lazy-2', 'preload-not-pinned', 'preload-project'].sort(),
    );
  });

  it('handles an empty pack list', () => {
    const { pinned, dynamic } = partitionSkills([]);
    expect(pinned).toEqual([]);
    expect(dynamic).toEqual([]);
  });

  it('handles a pack with no skills', () => {
    const pack = makePack('empty', 'universal', []);
    const { pinned, dynamic } = partitionSkills([pack]);
    expect(pinned).toEqual([]);
    expect(dynamic).toEqual([]);
  });
});

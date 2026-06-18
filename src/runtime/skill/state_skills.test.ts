/** SKILL.1 — state-keyed skill injection (deterministic, exact, no router guess). */
import { describe, expect, it } from 'vitest';

import type { StateMeta } from '../../packs/compile_v2.js';
import { InMemorySkillRuntime, onStateEntry, onStateLeave } from './state_skills.js';

const META: Record<string, StateMeta> = {
  spec_review: { kind: 'executor', executor: 'codex', skills: ['spec-authoring'] },
  size_gate: { kind: 'gate', skills: [], guard: 'size_ok' },
  build: { kind: 'executor', executor: 'codex', skills: ['impl', 'test-writer'] },
};

describe('state-keyed skill injection (SKILL.1)', () => {
  it('entering a state binds EXACTLY its skills + executor (the state is the router)', () => {
    const rt = new InMemorySkillRuntime();
    onStateEntry('spec_review', META, rt);
    expect(rt.current()).toEqual({ skills: ['spec-authoring'], executor: 'codex' });
  });

  it('leaving unloads the bound skills + executor', () => {
    const rt = new InMemorySkillRuntime();
    onStateEntry('build', META, rt);
    onStateLeave('build', rt);
    expect(rt.current()).toEqual({ skills: [], executor: null });
  });

  it('binding is EXACT, not additive across states (no cross-state bleed)', () => {
    const rt = new InMemorySkillRuntime();
    onStateEntry('build', META, rt); // [impl, test-writer]
    onStateEntry('spec_review', META, rt); // re-enter another state directly
    expect(rt.current()).toEqual({ skills: ['spec-authoring'], executor: 'codex' }); // ONLY the new state's
  });

  it('a state with no skills binds the empty set (NOT a fallback to "all")', () => {
    const rt = new InMemorySkillRuntime();
    onStateEntry('size_gate', META, rt);
    expect(rt.current()).toEqual({ skills: [], executor: null }); // gate has no executor, no skills
  });

  it('injection is deterministic — it reads only meta (no router/prefilter/classifier call)', () => {
    // The runtime exposes only bind/unload; there is no relevance-scoring hook to call.
    // Re-entering the same state twice yields byte-identical bindings (no nondeterminism).
    const a = new InMemorySkillRuntime();
    const b = new InMemorySkillRuntime();
    onStateEntry('build', META, a);
    onStateEntry('build', META, b);
    expect(a.current()).toEqual(b.current());
  });

  it('an unknown state is a loud bug (no silent empty bind)', () => {
    const rt = new InMemorySkillRuntime();
    expect(() => onStateEntry('ghost', META, rt)).toThrow(/no meta for state/);
  });
});

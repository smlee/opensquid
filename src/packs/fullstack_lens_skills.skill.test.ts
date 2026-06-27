/**
 * T2.13 — schema-validation + lens-SELECT test for fullstack-flow's TEN engineering lens skills.
 *
 * The engineering lens bucket (design §8): coding-principles · system-design · architecture · testing ·
 * observability · security · performance · accessibility · versioning · compliance. Each is a LAZY lens skill
 * (NO runtime cost unless selected, design §4.3) that surfaces 2 substantive lines of engineering guidance for
 * its lens. Mirrors `fullstack_pause_guard.skill.test.ts`: every skill.yaml parses against the REAL `Skill`
 * schema; the SELECT predicate picks the lens-bearing pack for a coding work-type and NOT for a non-coding one.
 *
 * SELECT-PREDICATE NOTE (tested in ISOLATION through the real select logic, not via a live v2 skill loader):
 *   The spec's `requires: { domain: coding }` is NOT a valid `Skill.requires` value (it is
 *   `z.array(SkillRequires)` — kinds automation_mode_on / active_task_present only, src/runtime/skill_requires.ts;
 *   an object fails parse). The REAL coding-domain select gate lives at the PACK level: fullstack-flow/pack.yaml
 *   declares `serves: { intent: produce, domain: coding }`, matched by `matchPacks` (src/packs/match.ts, ORCH.3).
 *   So the select assertion drives `matchPacks` over the REAL fullstack-flow pack: a `{produce, coding}` turn
 *   selects it (→ its lenses are in scope) and a non-coding turn (`{inform}` / `{produce, writing}`) does NOT.
 *   This is tested in isolation because the v2 PackV2 loader does NOT yet load a pack `skills/` dir for live
 *   selection (it loads only the FSM — the known gap deferred to T2.1); the same posture as the pause-guard test,
 *   which loads + validates the skill.yaml directly through the skill schema rather than via a live loader.
 */
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadPackV2 } from './loader_v2.js';
import { matchPacks } from './match.js';
import { Skill } from './schemas/skill.js';
import { parseYamlFile } from './yaml.js';

import type { Facets } from '../runtime/classify.js';

const HERE = fileURLToPath(import.meta.url);
const PACK_DIR = resolve(HERE, '../../../packs/builtin/fullstack-flow');
const SKILLS_DIR = resolve(PACK_DIR, 'skills');

// The engineering lens bucket verbatim (design §8) — the 10 skills T2.13 authors.
const LENSES = [
  'coding-principles',
  'system-design',
  'architecture',
  'testing',
  'observability',
  'security',
  'performance',
  'accessibility',
  'versioning',
  'compliance',
] as const;

function skillPath(lens: string): string {
  return resolve(SKILLS_DIR, lens, 'skill.yaml');
}

async function loadSkill(lens: string): Promise<Skill> {
  // `Skill` is a ZodObject whose input ≠ output (it has `.default()`s), so it isn't a `z.ZodType<Skill>`;
  // parse with the schema (which still VALIDATES the file against the schema) and assert the output type.
  const { data } = await parseYamlFile(skillPath(lens), Skill);
  return data as Skill;
}

const f = (over: Partial<Facets> & Pick<Facets, 'intent'>): Facets => ({
  project: true,
  confidence: 'high',
  ...over,
});

describe('fullstack-flow engineering lens skills (T2.13)', () => {
  it('the skills/ dir contains exactly the 10 engineering lenses (engineering bucket only — §5 OUT)', async () => {
    const dirents = await readdir(SKILLS_DIR, { withFileTypes: true });
    const dirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    // the pause-guard skills (H5: pause-guard-tool + pause-guard-stop) co-exist; the 10 lenses must all be
    // present and no OTHER lens (no frontend/business).
    for (const lens of LENSES) expect(dirs, `missing lens dir: ${lens}`).toContain(lens);
    const lensDirs = dirs.filter((d) => d !== 'pause-guard-tool' && d !== 'pause-guard-stop');
    expect(new Set(lensDirs)).toEqual(new Set(LENSES));
  });

  for (const lens of LENSES) {
    describe(lens, () => {
      it('parses against the real Skill schema', async () => {
        const skill = await loadSkill(lens);
        expect(skill.name).toBe(lens);
      });

      it('is a LAZY lens (load: lazy — NO runtime cost unless selected)', async () => {
        const skill = await loadSkill(lens);
        expect(skill.load).toBe('lazy');
      });

      it('triggers on tool_call', async () => {
        const skill = await loadSkill(lens);
        expect(skill.triggers.map((t) => t.kind)).toEqual(['tool_call']);
      });

      it('has a single <lens>-lens rule that surfaces a NON-EMPTY inject (verdict surface)', async () => {
        const skill = await loadSkill(lens);
        expect(skill.rules).toHaveLength(1);
        const rule = skill.rules[0];
        expect(rule?.id).toBe(`${lens}-lens`);
        if (rule?.kind !== 'track_check') throw new Error(`${lens} rule not a track_check`);
        const inject = rule.process.find((s) => s.call === 'verdict');
        expect(inject, `${lens} has no verdict (inject) step`).toBeDefined();
        const args = (inject?.args ?? {}) as { level?: string; message?: string };
        expect(args.level).toBe('surface'); // a non-blocking lens hint, not a gate
        expect(typeof args.message).toBe('string');
        expect((args.message ?? '').trim().length).toBeGreaterThan(40); // substantive, not filler
      });
    });
  }

  describe('coding-domain SELECT predicate (via the real serves matcher — see header note)', () => {
    it('a coding work-type selects the lens-bearing fullstack-flow pack', async () => {
      const { pack } = await loadPackV2(PACK_DIR);
      const r = matchPacks(f({ intent: 'produce', domain: 'coding' }), [pack]);
      expect(r.pack?.name).toBe('fullstack-flow'); // → its 10 engineering lenses are in scope
    });

    it('a NON-coding work-type does NOT select the pack (no lens runs — cost only when correct)', async () => {
      const { pack } = await loadPackV2(PACK_DIR);
      // doc-only / writing turn: serves.domain=coding does not match → no candidates.
      expect(matchPacks(f({ intent: 'inform' }), [pack]).candidates).toEqual([]);
      expect(matchPacks(f({ intent: 'produce', domain: 'writing' }), [pack]).candidates).toEqual(
        [],
      );
    });
  });
});

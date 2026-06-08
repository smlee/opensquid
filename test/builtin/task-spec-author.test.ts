/**
 * E2E test for the built-in task-spec-author profession pack.
 *
 * Per T-DISCIPLINE-PIPELINE-COMPLETION DPC.1 (2026-05-30): ships the
 * profession-pack handle that chain-handoff-research-to-spec directive
 * routes to (next_action.profession: task-spec-author). Has no rules of
 * its own — the discipline lives in the bundled SKILL.md format authority.
 *
 * Source: docs/tasks/T-discipline-pipeline-completion.md DPC.1 acceptance.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { validatePackFunctions } from '../../src/packs/validate_functions.js';
import { buildRegistry } from '../../src/runtime/bootstrap.js';

describe('builtin task-spec-author profession pack', () => {
  it('loads cleanly via loadPack', async () => {
    const pack = await loadPack(resolve('packs/builtin/task-spec-author'));
    expect(pack.name).toBe('task-spec-author');
    expect(pack.scope).toBe('universal');
    expect(pack.evolves).toBe(false);
    expect(pack.goal).toMatch(/11-field/);
  });

  it('has no rules (profession pack — format authority is the bundled SKILL.md)', async () => {
    const pack = await loadPack(resolve('packs/builtin/task-spec-author'));
    expect(pack.skills.length).toBe(0);
  });

  it('passes validatePackFunctions (no rules → no primitive refs to resolve)', async () => {
    const pack = await loadPack(resolve('packs/builtin/task-spec-author'));
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

  it('ships team.yaml + SKILL.md + skills-catalog.md as format-authority bundle', () => {
    const packDir = resolve('packs/builtin/task-spec-author');
    expect(existsSync(`${packDir}/team.yaml`)).toBe(true);
    expect(existsSync(`${packDir}/SKILL.md`)).toBe(true);
    expect(existsSync(`${packDir}/skills-catalog.md`)).toBe(true);
  });
});

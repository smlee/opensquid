/**
 * "Gates teach their rubric" coverage (TR.C, wg-2d1d8698f563).
 *
 * The heavy-rubric gate (coding-flow) must pair its reactive audit with a proactive delivery of the SAME
 * canonical rubric to the agent; pack-architect must teach the discipline; light block/warn gates teach via a
 * remedy-naming message.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';

describe('gates teach their rubric (TR.C, wg-2d1d8698f563)', () => {
  it('coding-flow: the audit READS read_rubric and a paired rule DELIVERS it (one source)', async () => {
    const pack = await loadPack(resolve('packs/builtin/coding-flow'));
    const lifecycle = pack.skills.find((s) => s.name === 'scope-lifecycle');
    const entry = pack.skills.find((s) => s.name === 'entry-and-handoffs');
    // the guess/spec audits read the canonical rubric (TR.A)…
    const auditReadsRubric = (lifecycle?.rules ?? []).some(
      (r) => 'process' in r && r.process.some((p) => p.call === 'read_rubric'),
    );
    // …and a paired rule delivers it to the agent before authoring (TR.B).
    const transferDelivers = (entry?.rules ?? []).some(
      (r) => 'process' in r && r.process.some((p) => p.call === 'rubric_pre_inject'),
    );
    expect(auditReadsRubric).toBe(true);
    expect(transferDelivers).toBe(true);
  });

  it('pack-architect teaches the "gates teach their rubric" discipline', async () => {
    const skill = await readFile(
      resolve('packs/builtin/pack-architect/skills/skill-yaml-author-walkthrough/skill.yaml'),
      'utf8',
    );
    expect(skill).toMatch(/GATES TEACH/);
    expect(skill).toMatch(/read_rubric/); // the checklist names the canonical-rubric delivery mechanism
    const doc = await readFile(resolve('packs/builtin/pack-architect/SKILL.md'), 'utf8');
    expect(doc).toMatch(/gates teach their rubric/i);
  });

  it('light-gate packs teach via a remedy-naming block message (default-discipline never-amend)', async () => {
    const manifest = await readFile(
      resolve('packs/builtin/default-discipline/manifest.yaml'),
      'utf8',
    );
    // never-amend's message names the remedy (make a follow-up commit), not just "blocked".
    expect(manifest).toMatch(/make a follow-up commit/i);
  });
});

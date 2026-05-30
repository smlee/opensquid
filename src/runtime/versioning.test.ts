/**
 * LP.2 — unit tests for runThreeWayMerge.
 *
 * Inline fixtures: each test stages base/ + vanilla/ + personalStateDir/
 * tmpdir trees via mkdir+writeFile in beforeEach. No separate fixture
 * directory needed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendLessonFile, initPersonalRevision } from '../packs/personal_revision.js';

import { runThreeWayMerge, type ThreeWayMergeInput } from './versioning.js';

let root: string;
let baseDir: string;
let vanillaDir: string;
let personalDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'opensquid-lp2-'));
  baseDir = join(root, 'base');
  vanillaDir = join(root, 'vanilla');
  personalDir = join(root, 'personal');
  await mkdir(baseDir, { recursive: true });
  await mkdir(vanillaDir, { recursive: true });
  await mkdir(personalDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(dir: string, relPath: string, body: string): Promise<void> {
  const full = join(dir, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body, 'utf8');
}

function input(over: Partial<ThreeWayMergeInput> = {}): ThreeWayMergeInput {
  return {
    packId: 'test-pack',
    baseDir,
    personalStateDir: personalDir,
    vanillaDir,
    vanillaVersion: '1.1.0',
    ...over,
  };
}

describe('runThreeWayMerge — preconditions + idempotency', () => {
  it('throws when version.json is missing', async () => {
    await expect(runThreeWayMerge(input())).rejects.toThrow(/install pack first/);
  });

  it('throws on downgrade (vanilla < base)', async () => {
    await initPersonalRevision(personalDir, '2.0.0');
    await expect(runThreeWayMerge(input({ vanillaVersion: '1.0.0' }))).rejects.toThrow(
      /must be >=/,
    );
  });

  it('idempotent: re-run with same vanillaVersion → noop, no file writes', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    const first = await runThreeWayMerge(input({ vanillaVersion: '1.1.0' }));
    expect(first.noop).toBe(false);
    const second = await runThreeWayMerge(input({ vanillaVersion: '1.1.0' }));
    expect(second.noop).toBe(true);
    expect(second.dispositions).toEqual([]);
  });

  it('new vanilla version (1.2.0) after 1.1.0 merge → NOT noop; runs again', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await runThreeWayMerge(input({ vanillaVersion: '1.1.0' }));
    const next = await runThreeWayMerge(input({ vanillaVersion: '1.2.0' }));
    expect(next.noop).toBe(false);
  });
});

describe('runThreeWayMerge — disposition classification', () => {
  it('unchanged: base + vanilla identical → all unchanged', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'skills/a/skill.yaml', 'name: a\n');
    await writeSkill(vanillaDir, 'skills/a/skill.yaml', 'name: a\n');
    const r = await runThreeWayMerge(input());
    expect(r.ok).toBe(true);
    expect(r.dispositions).toContainEqual({ kind: 'unchanged', path: 'skills/a/skill.yaml' });
    expect(r.conflictCount).toBe(0);
  });

  it('auto-merged-vanilla: vanilla adds new skill file + personal untouched', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(vanillaDir, 'skills/new/skill.yaml', 'name: new\n');
    const r = await runThreeWayMerge(input());
    expect(r.dispositions).toContainEqual({
      kind: 'auto-merged-vanilla',
      path: 'skills/new/skill.yaml',
      reason: 'vanilla-only-edit',
    });
  });

  it('auto-merged-personal: personal lesson exists for untouched skill', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'skills/a/skill.yaml', 'name: a\n');
    await writeSkill(vanillaDir, 'skills/a/skill.yaml', 'name: a\n');
    await appendLessonFile(personalDir, { skill: 'skills/a/skill.yaml', note: 'tweaked' });
    const r = await runThreeWayMerge(input());
    expect(r.dispositions.some((d) => d.kind === 'auto-merged-personal')).toBe(true);
  });

  it('conflict: vanilla edits skill_a + personal lesson references skill_a', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'skills/a/skill.yaml', 'name: a\nversion: 1\n');
    await writeSkill(vanillaDir, 'skills/a/skill.yaml', 'name: a\nversion: 2\n');
    await appendLessonFile(personalDir, { skill: 'skills/a/skill.yaml', note: 'edit' });
    const r = await runThreeWayMerge(input());
    const conflict = r.dispositions.find((d) => d.kind === 'conflict');
    expect(conflict).toBeDefined();
    expect(r.conflictCount).toBe(1);
    if (conflict?.kind === 'conflict') {
      const sidecar = await readFile(conflict.conflictSidecarPath, 'utf8');
      expect(sidecar).toContain('<<<<<<< base');
      expect(sidecar).toContain('=======');
      expect(sidecar).toContain('>>>>>>> vanilla 1.1.0');
      expect(sidecar).toContain('# version: 1'); // base
      expect(sidecar).toContain('# version: 2'); // vanilla
    }
  });

  it('vanilla deletes skill + personal references it → conflict', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'skills/b/skill.yaml', 'name: b\n');
    // vanilla does NOT have skills/b/
    await appendLessonFile(personalDir, { skill: 'skills/b/skill.yaml' });
    const r = await runThreeWayMerge(input());
    expect(r.dispositions.some((d) => d.kind === 'conflict')).toBe(true);
  });

  it('empty base + empty vanilla + empty personal → empty dispositions, ok', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    const r = await runThreeWayMerge(input());
    expect(r.ok).toBe(true);
    expect(r.noop).toBe(false);
    expect(r.dispositions).toEqual([]);
    expect(r.conflictCount).toBe(0);
  });
});

describe('runThreeWayMerge — sidecar + version.json side effects', () => {
  it('updates last_merged_vanilla to vanillaVersion on success', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await runThreeWayMerge(input({ vanillaVersion: '1.5.0' }));
    const { readVersionJson } = await import('../packs/personal_revision.js');
    const v = await readVersionJson(personalDir);
    expect(v?.last_merged_vanilla).toBe('1.5.0');
  });

  it('sidecar is YAML-comment-safe (every conflict-marker line starts with #)', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'skills/a/skill.yaml', 'name: a\nversion: 1\n');
    await writeSkill(vanillaDir, 'skills/a/skill.yaml', 'name: a\nversion: 2\n');
    await appendLessonFile(personalDir, { skill: 'skills/a/skill.yaml' });
    const r = await runThreeWayMerge(input());
    const conflict = r.dispositions.find((d) => d.kind === 'conflict');
    if (conflict?.kind !== 'conflict') throw new Error('expected conflict');
    const sidecar = await readFile(conflict.conflictSidecarPath, 'utf8');
    const markerLines = sidecar
      .split('\n')
      .filter(
        (l) => /^(<<<<<<<|=======|>>>>>>>)/.test(l) || /^(#\s+(<<<<<<<|=======|>>>>>>>))/.test(l),
      );
    // Every conflict-marker line must be #-prefixed (no bare git markers).
    for (const line of markerLines) {
      expect(line.startsWith('#')).toBe(true);
    }
  });

  it('multiple personal lessons referencing same conflicted skill → only first triggers sidecar', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'skills/a/skill.yaml', 'v: 1\n');
    await writeSkill(vanillaDir, 'skills/a/skill.yaml', 'v: 2\n');
    await appendLessonFile(personalDir, { skill: 'skills/a/skill.yaml', note: 'one' });
    await appendLessonFile(personalDir, { skill: 'skills/a/skill.yaml', note: 'two' });
    const r = await runThreeWayMerge(input());
    expect(r.conflictCount).toBe(1);
    expect(r.dispositions.filter((d) => d.kind === 'auto-merged-personal')).toHaveLength(1);
  });

  it('node_modules/.git/.opensquid/personal_revision dirs are skipped by walker', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'node_modules/foo/skill.yaml', 'noise: true\n');
    await writeSkill(vanillaDir, '.git/HEAD', 'noise: true\n');
    await writeSkill(baseDir, 'skills/a/skill.yaml', 'real: yes\n');
    await writeSkill(vanillaDir, 'skills/a/skill.yaml', 'real: yes\n');
    const r = await runThreeWayMerge(input());
    expect(r.dispositions).toHaveLength(1);
    expect(r.dispositions[0]).toEqual({ kind: 'unchanged', path: 'skills/a/skill.yaml' });
  });

  it('non-yaml/md extensions are ignored by walker', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await writeSkill(baseDir, 'skills/a/skill.json', '{"a":1}');
    await writeSkill(vanillaDir, 'skills/a/skill.json', '{"a":2}');
    await writeSkill(baseDir, 'skills/a/skill.yaml', 'name: a\n');
    await writeSkill(vanillaDir, 'skills/a/skill.yaml', 'name: a\n');
    const r = await runThreeWayMerge(input());
    expect(r.dispositions).toHaveLength(1);
    expect(r.dispositions[0]).toMatchObject({ path: 'skills/a/skill.yaml' });
  });

  it('result carries packId + baseVersion + personalRevisionId', async () => {
    await initPersonalRevision(personalDir, '1.0.0');
    await appendLessonFile(personalDir, { note: 'one' });
    await appendLessonFile(personalDir, { note: 'two' });
    const r = await runThreeWayMerge(input({ packId: 'my-pack' }));
    expect(r.packId).toBe('my-pack');
    expect(r.baseVersion).toBe('1.0.0');
    expect(r.personalRevisionId).toBe(2);
    expect(r.vanillaVersion).toBe('1.1.0');
  });
});

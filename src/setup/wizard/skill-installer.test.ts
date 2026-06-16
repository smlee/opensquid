/**
 * PT.2 — `installPacksSkill` unit tests (over a temp home, no real ~/.claude touched).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installPacksSkill } from './skill-installer.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-skill-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const dest = (h: string): string => join(h, '.claude', 'skills', 'packs', 'SKILL.md');

describe('installPacksSkill', () => {
  it('fresh install writes the /packs SKILL.md + reports createdSkillsDir', async () => {
    const r = await installPacksSkill(home);
    expect(r.written).toBe(dest(home));
    expect(r.createdSkillsDir).toBe(true);
    expect(r.backupPath).toBeUndefined();
    const body = await readFile(dest(home), 'utf8');
    expect(body).toContain('name: packs');
    expect(body).toContain('opensquid pack list');
    expect(body).toContain('opensquid pack set');
  });

  it('is idempotent and backs up an existing file on re-run', async () => {
    await installPacksSkill(home);
    const first = await readFile(dest(home), 'utf8');
    const r2 = await installPacksSkill(home);
    expect(r2.createdSkillsDir).toBe(false); // dir already existed the second time
    expect(r2.backupPath).toBeDefined(); // prior file moved aside
    expect(await readFile(dest(home), 'utf8')).toBe(first); // same shipped content
    expect(await readFile(r2.backupPath!, 'utf8')).toBe(first); // backup preserved
  });

  it('leaves a sibling skill untouched', async () => {
    const other = join(home, '.claude', 'skills', 'other', 'SKILL.md');
    await mkdir(join(home, '.claude', 'skills', 'other'), { recursive: true });
    await writeFile(other, '---\nname: other\n---\nleave me alone\n');
    await installPacksSkill(home);
    expect(await readFile(other, 'utf8')).toBe('---\nname: other\n---\nleave me alone\n');
  });

  it('createdSkillsDir is false when the skills dir already exists', async () => {
    await mkdir(join(home, '.claude', 'skills'), { recursive: true });
    const r = await installPacksSkill(home);
    expect(r.createdSkillsDir).toBe(false);
  });
});

describe('shipped /packs skill artifact', () => {
  it('claude-skills/packs/SKILL.md exists and references the PT.1 CLI', async () => {
    // Resolve from the repo root (this test file is src/setup/wizard/).
    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    const body = await readFile(join(repoRoot, 'claude-skills', 'packs', 'SKILL.md'), 'utf8');
    expect(body).toContain('opensquid pack list');
    expect(body).toContain('opensquid pack set');
  });
});

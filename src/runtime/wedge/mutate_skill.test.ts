/**
 * Tests for `bumpSkillVersion` (Task 7.4).
 *
 * Acceptance per phase-7-wedge-gate.md §"Task 7.4":
 *  - Patch-only bump (per `feedback_pre1_versioning`).
 *  - YAML comments preserved.
 *  - Idempotent on rerun (`0.1.1` → `0.1.2`).
 *  - Invalid version throws.
 *  - ≥ 3 tests.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bumpSkillVersion } from './mutate_skill.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = join(tmpdir(), `opensquid-mutate-${Math.random().toString(36).slice(2, 10)}`);
  await mkdir(tempDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeSkill(name: string, body: string): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, body, 'utf8');
  return path;
}

describe('bumpSkillVersion', () => {
  it('bumps the patch field (0.1.0 → 0.1.1)', async () => {
    const path = await writeSkill('a.yaml', 'name: demo\nversion: 0.1.0\nload: lazy\n');
    const next = await bumpSkillVersion(path);
    expect(next).toBe('0.1.1');
    const raw = await readFile(path, 'utf8');
    expect(raw).toMatch(/version: 0\.1\.1/);
  });

  it('preserves comments + key ordering across the round-trip', async () => {
    const skill = [
      '# Top-of-file comment',
      'name: demo',
      '# version is bumped by the wedge gate',
      'version: 0.2.5',
      '# load mode controls preload vs lazy',
      'load: preload',
      '',
    ].join('\n');
    const path = await writeSkill('b.yaml', skill);
    await bumpSkillVersion(path);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('# Top-of-file comment');
    expect(raw).toContain('# version is bumped by the wedge gate');
    expect(raw).toContain('# load mode controls preload vs lazy');
    expect(raw).toContain('version: 0.2.6');
    // Key order: name appears before version appears before load.
    const nameIdx = raw.indexOf('name:');
    const versionIdx = raw.indexOf('version:');
    const loadIdx = raw.indexOf('load:');
    expect(nameIdx).toBeLessThan(versionIdx);
    expect(versionIdx).toBeLessThan(loadIdx);
  });

  it('is idempotent on rerun (0.1.0 → 0.1.1 → 0.1.2)', async () => {
    const path = await writeSkill('c.yaml', 'name: demo\nversion: 0.1.0\n');
    expect(await bumpSkillVersion(path)).toBe('0.1.1');
    expect(await bumpSkillVersion(path)).toBe('0.1.2');
    expect(await bumpSkillVersion(path)).toBe('0.1.3');
  });

  it('throws on invalid semver string', async () => {
    const path = await writeSkill('d.yaml', 'name: demo\nversion: not-a-semver\n');
    await expect(bumpSkillVersion(path)).rejects.toThrow(/Cannot bump invalid version/);
  });

  it('defaults missing version to 0.0.0 (first bump → 0.0.1)', async () => {
    const path = await writeSkill('e.yaml', 'name: demo\nload: lazy\n');
    expect(await bumpSkillVersion(path)).toBe('0.0.1');
  });
});

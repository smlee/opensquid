/**
 * LP.1 — unit tests for personal_revision I/O helpers + schema.
 *
 * 8 cases covering version.json round-trip, atomic write, lesson file
 * enumeration, appendLessonFile bump, idempotent init. Schema tests for
 * BaseVersion + PersonalRevision live in manifest.test.ts (LP.1).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendLessonFile,
  initPersonalRevision,
  readLessonFiles,
  readVersionJson,
  writeVersionJson,
} from './personal_revision.js';

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'opensquid-lp1-'));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('readVersionJson / writeVersionJson — round-trip', () => {
  it('returns null when personal_revision/ dir is absent', async () => {
    expect(await readVersionJson(stateDir)).toBeNull();
  });

  it('writes + reads back the same shape', async () => {
    await writeVersionJson(stateDir, {
      base_version: '1.2.3',
      personal_revision_id: 0,
      last_merged_vanilla: null,
    });
    const read = await readVersionJson(stateDir);
    expect(read).toEqual({
      base_version: '1.2.3',
      personal_revision_id: 0,
      last_merged_vanilla: null,
    });
  });

  it('throws on malformed JSON (loud — engine wrote it)', async () => {
    await mkdir(join(stateDir, 'personal_revision'), { recursive: true });
    await writeFile(join(stateDir, 'personal_revision', 'version.json'), '{not json', 'utf8');
    await expect(readVersionJson(stateDir)).rejects.toThrow();
  });

  it('throws on schema-invalid shape (e.g. personal_revision_id: "abc")', async () => {
    await mkdir(join(stateDir, 'personal_revision'), { recursive: true });
    await writeFile(
      join(stateDir, 'personal_revision', 'version.json'),
      JSON.stringify({
        base_version: '1.2.3',
        personal_revision_id: 'abc',
        last_merged_vanilla: null,
      }),
      'utf8',
    );
    await expect(readVersionJson(stateDir)).rejects.toThrow();
  });
});

describe('readLessonFiles — monotonic enumeration', () => {
  it('returns [] when personal_revision/ dir absent', async () => {
    expect(await readLessonFiles(stateDir)).toEqual([]);
  });

  it('sorts by id ascending + marks conflict sidecars', async () => {
    const dir = join(stateDir, 'personal_revision');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'lesson_5.yaml'), 'a: 5\n', 'utf8');
    await writeFile(join(dir, 'lesson_3.conflict.yaml'), 'a: 3\n', 'utf8');
    await writeFile(join(dir, 'lesson_1.yaml'), 'a: 1\n', 'utf8');
    await writeFile(join(dir, 'README.md'), 'noise', 'utf8'); // skipped
    const out = await readLessonFiles(stateDir);
    expect(out.map((l) => l.id)).toEqual([1, 3, 5]);
    expect(out.find((l) => l.id === 3)?.hasConflict).toBe(true);
    expect(out.find((l) => l.id === 5)?.hasConflict).toBe(false);
    expect(out.find((l) => l.id === 1)?.body).toEqual({ a: 1 });
  });
});

describe('appendLessonFile — id bump + atomic write', () => {
  it('throws when version.json missing (caller forgot init)', async () => {
    await expect(appendLessonFile(stateDir, { lesson: 'first' })).rejects.toThrow(
      /install pack first/,
    );
  });

  it('writes lesson_1.yaml + bumps id to 1 on first append', async () => {
    await initPersonalRevision(stateDir, '0.1.0');
    const id = await appendLessonFile(stateDir, { rule: 'never-amend' });
    expect(id).toBe(1);
    const lessons = await readLessonFiles(stateDir);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.id).toBe(1);
    expect(lessons[0]?.body).toEqual({ rule: 'never-amend' });
    const version = await readVersionJson(stateDir);
    expect(version?.personal_revision_id).toBe(1);
  });

  it('two sequential appends produce lesson_1 + lesson_2; revision_id climbs to 2', async () => {
    await initPersonalRevision(stateDir, '0.1.0');
    await appendLessonFile(stateDir, { a: 1 });
    await appendLessonFile(stateDir, { b: 2 });
    const lessons = await readLessonFiles(stateDir);
    expect(lessons.map((l) => l.id)).toEqual([1, 2]);
    expect((await readVersionJson(stateDir))?.personal_revision_id).toBe(2);
  });
});

describe('initPersonalRevision — idempotent', () => {
  it('first call writes version.json with revision_id 0 + null last_merged', async () => {
    const out = await initPersonalRevision(stateDir, '2.0.0');
    expect(out).toEqual({
      base_version: '2.0.0',
      personal_revision_id: 0,
      last_merged_vanilla: null,
    });
  });

  it('second call with different baseVersion returns EXISTING state (no overwrite)', async () => {
    await initPersonalRevision(stateDir, '1.0.0');
    await appendLessonFile(stateDir, { a: 1 });
    const out = await initPersonalRevision(stateDir, '99.0.0');
    expect(out.base_version).toBe('1.0.0');
    expect(out.personal_revision_id).toBe(1);
  });
});

describe('atomic write — temp file does not survive rename', () => {
  it('after writeVersionJson, no .tmp.* file remains in personal_revision/', async () => {
    await writeVersionJson(stateDir, {
      base_version: '1.0.0',
      personal_revision_id: 0,
      last_merged_vanilla: null,
    });
    const entries = await readFile(join(stateDir, 'personal_revision', 'version.json'), 'utf8');
    expect(entries).toContain('1.0.0');
    // Manual readdir to verify no .tmp files leaked
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(join(stateDir, 'personal_revision'));
    expect(names.filter((n) => n.includes('.tmp.'))).toEqual([]);
  });
});

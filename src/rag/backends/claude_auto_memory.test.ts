/**
 * Tests for `claudeAutoMemoryBackend`.
 *
 * Strategy: per-test temp HOME (mkdtemp under `os.tmpdir()`); set
 * `CLAUDE_PROJECT_DIR` to an arbitrary absolute path; mock `os.homedir`
 * to point at the temp HOME so the backend's `projectMemoryDir()`
 * resolves under our temp tree. Each test gets a fresh directory, so
 * tests don't see each other's writes.
 *
 * Coverage:
 *   1. recall() matches `.md` files by substring; MEMORY.md excluded.
 *   2. storeLesson() writes `<id>.md` with frontmatter.
 *   3. init() throws when CLAUDE_PROJECT_DIR is unset.
 *   4. storeLesson() rejects `..` traversal in `lesson.id`.
 *   5. recall() on a missing dir returns [] (no throw).
 *   6. embed() always returns null.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as realOs from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Lesson } from '../types.js';

// `homedir` is a non-configurable property on `node:os`'s ESM
// namespace, so `vi.spyOn` cannot redefine it. `vi.mock` replaces the
// module wholesale, giving us a `homedir` that can be re-stubbed per
// test via `mockReturnValue`. We re-export everything else verbatim so
// the rest of the module (`tmpdir`, etc.) still works.
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof realOs>('node:os');
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

// Import AFTER the mock is registered so the backend sees the mocked module.
const { claudeAutoMemoryBackend } = await import('./claude_auto_memory.js');
const os = await import('node:os');

function mkLesson(id: string, content: string, tags: string[] = []): Lesson {
  return {
    id,
    content,
    tags,
    source: 'test',
    author: 'agent',
    createdAt: '2026-05-19T00:00:00.000Z',
  };
}

describe('claudeAutoMemoryBackend', () => {
  let tmpHome: string;
  let projectDir: string;
  let memDir: string;
  let savedProjectDir: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(realOs.tmpdir(), 'opensquid-cam-'));
    // Pick an arbitrary absolute project path; the slug transform
    // (`/Users/x` → `-Users-x`) must work the same on any input. We use
    // a path independent of the real machine so tests are portable.
    projectDir = '/tmp/fixture-project';
    const slug = projectDir.replaceAll('/', '-');
    memDir = join(tmpHome, '.claude', 'projects', slug, 'memory');

    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    // `homedir()` is a sync call inside `projectMemoryDir`; spying makes
    // the temp HOME visible without depending on `$HOME` env override
    // (which Node caches on some platforms).
    vi.mocked(os.homedir).mockReturnValue(tmpHome);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('recall matches .md files by substring and excludes MEMORY.md', async () => {
    await mkdir(memDir, { recursive: true });
    // Two files contain "git", one doesn't, plus a MEMORY.md index that
    // also contains "git" — it must be filtered out.
    await writeFile(join(memDir, 'a.md'), '---\nid: a\n---\nlearning about git rebase', 'utf8');
    await writeFile(join(memDir, 'b.md'), '---\nid: b\n---\nunrelated content', 'utf8');
    await writeFile(join(memDir, 'c.md'), '---\nid: c\n---\ngit commit hygiene rule', 'utf8');
    await writeFile(join(memDir, 'MEMORY.md'), '- index pointing to git topics', 'utf8');

    const backend = claudeAutoMemoryBackend();
    await backend.init();
    const hits = await backend.recall('git', 5);

    const ids = hits.map((h) => h.lesson.id).sort();
    expect(ids).toEqual(['a', 'c']);
    expect(hits.every((h) => h.source === 'lexical')).toBe(true);
    expect(hits.every((h) => h.lesson.author === 'user')).toBe(true);
  });

  it('storeLesson writes <id>.md with frontmatter', async () => {
    await mkdir(memDir, { recursive: true });
    const backend = claudeAutoMemoryBackend();
    await backend.init();

    const lesson = mkLesson('L1', 'lesson body text', ['workflow', 'phase']);
    await backend.storeLesson(lesson);

    const written = await readFile(join(memDir, 'L1.md'), 'utf8');
    expect(written).toContain('---');
    expect(written).toContain('id: L1');
    expect(written).toContain('source: test');
    expect(written).toContain('author: agent');
    expect(written).toContain('createdAt: 2026-05-19T00:00:00.000Z');
    expect(written).toContain('tags: [workflow, phase]');
    expect(written).toContain('lesson body text');
  });

  it('init throws when CLAUDE_PROJECT_DIR is unset', async () => {
    delete process.env.CLAUDE_PROJECT_DIR;
    const backend = claudeAutoMemoryBackend();
    await expect(backend.init()).rejects.toThrow(/CLAUDE_PROJECT_DIR/);
  });

  it('storeLesson rejects `..` traversal in lesson.id', async () => {
    await mkdir(memDir, { recursive: true });
    const backend = claudeAutoMemoryBackend();
    await backend.init();

    // `../../../etc/passwd` would otherwise resolve OUTSIDE the memory
    // dir; the assertInDir check must reject it.
    const evil = mkLesson(`..${sep}..${sep}..${sep}etc${sep}passwd`, 'malicious');
    await expect(backend.storeLesson(evil)).rejects.toThrow(/path traversal/);

    // Sibling form: id starts with `..` directly.
    const evil2 = mkLesson(`..${sep}evil`, 'malicious');
    await expect(backend.storeLesson(evil2)).rejects.toThrow(/path traversal/);
  });

  it('recall on a missing dir returns [] without throwing', async () => {
    // Do NOT create memDir. The backend should swallow ENOENT.
    const backend = claudeAutoMemoryBackend();
    await backend.init();
    const hits = await backend.recall('anything', 5);
    expect(hits).toEqual([]);
  });

  it('embed always returns null', async () => {
    await mkdir(memDir, { recursive: true });
    const backend = claudeAutoMemoryBackend();
    await backend.init();
    expect(await backend.embed('some text')).toBeNull();
    expect(await backend.embed('')).toBeNull();
  });
});

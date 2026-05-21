/**
 * Tests for the pack folder loader (`loader.ts`).
 *
 * Coverage matches Task 2.3 spec §"Test fixtures" + acceptance criteria:
 *   1. minimal/ fixture → Pack loads, skills: [].
 *   2. full/ fixture → 2 skills loaded, sorted alphabetically (docs, git).
 *   3. nonexistent dir → throws a path-bearing error.
 *   4. bad manifest (missing required field) → error names file + Zod path.
 *   5. skills/ with a non-dir entry (stray file) → skipped, pack still loads.
 *   6. (Bonus) symlink inside skills/ pointing at another skill dir → followed.
 *
 * Fixtures 1 + 2 live under `test/fixtures/packs/{minimal,full}/` as canonical
 * examples. Fixtures 3-6 build per-test temp dirs in `os.tmpdir()` so the
 * canonical fixtures stay clean and tests stay independent.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPack } from './loader.js';

// Resolve fixtures relative to this source file so the test works regardless
// of where vitest is invoked from.
const FIXTURES_DIR = resolve(fileURLToPath(import.meta.url), '../../../test/fixtures/packs');

describe('loadPack — fixture-based smoke tests', () => {
  it('loads the minimal fixture with the four required manifest fields and no skills', async () => {
    const pack = await loadPack(join(FIXTURES_DIR, 'minimal'));

    expect(pack.name).toBe('minimal');
    expect(pack.version).toBe('0.1.0');
    expect(pack.scope).toBe('workflow');
    expect(pack.goal).toBe('smoke test');
    // Defaults from the Manifest schema fill these in.
    expect(pack.description).toBe('');
    expect(pack.requires).toEqual([]);
    expect(pack.conflicts).toEqual([]);
    expect(pack.evolves).toBe(true);
    expect(pack.skills).toEqual([]);
  });

  it('loads the full fixture with all manifest fields populated and skills sorted alphabetically', async () => {
    const pack = await loadPack(join(FIXTURES_DIR, 'full'));

    expect(pack.name).toBe('full');
    expect(pack.version).toBe('0.2.0');
    expect(pack.scope).toBe('project');
    expect(pack.description).toBe(
      'full pack fixture exercising all manifest fields and skill ordering',
    );
    expect(pack.requires).toEqual(['some-other-pack']);
    expect(pack.conflicts).toEqual(['clashing-pack']);
    expect(pack.evolves).toBe(false);

    // Sort order: docs < git lexicographically. Verifies the explicit
    // `entries.sort()` in `loadSkillsDir` (APFS isn't guaranteed alphabetical).
    expect(pack.skills.map((s) => s.name)).toEqual(['docs', 'git']);

    // Skill bodies parsed through the Skill schema — spot-check shape.
    const gitSkill = pack.skills.find((s) => s.name === 'git');
    expect(gitSkill?.load).toBe('preload');
    expect(gitSkill?.rules).toHaveLength(1);
    expect(gitSkill?.rules[0]?.id).toBe('block-force-push');
  });
});

describe('loadPack — error + edge cases', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-loader-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws a path-bearing error when the pack directory does not exist', async () => {
    const missing = join(dir, 'does-not-exist');
    await expect(loadPack(missing)).rejects.toThrow(/manifest\.yaml/);
  });

  it('surfaces both the manifest file path and the Zod field path when a required manifest field is missing', async () => {
    // No `scope:` — schema requires it.
    const manifest = ['name: bad', 'version: 0.1.0', 'goal: missing scope'].join('\n') + '\n';
    const manifestPath = join(dir, 'manifest.yaml');
    await writeFile(manifestPath, manifest, 'utf8');

    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // File path comes from parseYamlFile.
    expect(msg).toContain(manifestPath);
    // Zod renders the missing field name into its message — the field path is
    // what makes this error actionable. The Zod error message includes the
    // field name in its issue list.
    expect(msg.toLowerCase()).toContain('scope');
  });

  it('skips a non-directory entry inside skills/ and still loads the rest of the pack', async () => {
    // Minimal manifest.
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-stray', 'version: 0.1.0', 'scope: workflow', 'goal: test stray skips'].join(
        '\n',
      ) + '\n',
      'utf8',
    );

    await mkdir(join(dir, 'skills', 'real-skill'), { recursive: true });
    await writeFile(
      join(dir, 'skills', 'real-skill', 'skill.yaml'),
      ['name: real-skill', 'load: lazy'].join('\n') + '\n',
      'utf8',
    );

    // Stray file directly in skills/ — must be skipped, not parsed as a skill.
    await writeFile(join(dir, 'skills', 'README.md'), '# stray file\n', 'utf8');
    // Also a dotfile that macOS likes to drop — also must be skipped.
    await writeFile(join(dir, 'skills', '.DS_Store'), 'binary garbage', 'utf8');

    const pack = await loadPack(dir);
    expect(pack.skills.map((s) => s.name)).toEqual(['real-skill']);
  });

  it('loads chat_agent.yaml when present, folding it into Pack.chatAgent', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-chat-agent', 'version: 0.1.0', 'scope: workflow', 'goal: WAB.6 binding'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'chat_agent.yaml'),
      [
        'default_model: fast_chat',
        'system_prompt: prompts/chat.md',
        'max_tokens: 2048',
        'disable_builtins:',
        '  - recall',
      ].join('\n') + '\n',
      'utf8',
    );

    const pack = await loadPack(dir);
    expect(pack.chatAgent).toBeDefined();
    expect(pack.chatAgent?.default_model).toBe('fast_chat');
    expect(pack.chatAgent?.system_prompt).toBe('prompts/chat.md');
    expect(pack.chatAgent?.max_tokens).toBe(2048);
    expect(pack.chatAgent?.disable_builtins).toEqual(['recall']);
    // Defaults still applied for unspecified fields.
    expect(pack.chatAgent?.max_tool_iterations).toBe(8);
    expect(pack.chatAgent?.skills).toEqual([]);
  });

  it('leaves Pack.chatAgent undefined when chat_agent.yaml is absent', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: no-chat-agent', 'version: 0.1.0', 'scope: workflow', 'goal: no side-file'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    const pack = await loadPack(dir);
    expect(pack.chatAgent).toBeUndefined();
  });

  it('surfaces a chat_agent.yaml schema error verbatim (typo top-level key)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: bad-chat-agent', 'version: 0.1.0', 'scope: workflow', 'goal: bad side-file'].join(
        '\n',
      ) + '\n',
      'utf8',
    );
    // `defualt_model` typo — strict-mode rejection.
    await writeFile(
      join(dir, 'chat_agent.yaml'),
      ['defualt_model: fast_chat'].join('\n') + '\n',
      'utf8',
    );

    let caught: unknown;
    try {
      await loadPack(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('chat_agent.yaml');
  });

  it('follows symlinks inside skills/ to their target directory (documented behavior)', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      ['name: with-symlink', 'version: 0.1.0', 'scope: workflow', 'goal: symlink test'].join('\n') +
        '\n',
      'utf8',
    );

    // Real skill directory outside `skills/`.
    const externalSkillDir = join(dir, 'external-skill');
    await mkdir(externalSkillDir, { recursive: true });
    await writeFile(
      join(externalSkillDir, 'skill.yaml'),
      ['name: linked-skill', 'load: lazy'].join('\n') + '\n',
      'utf8',
    );

    // skills/ contains only a symlink pointing at the external dir.
    await mkdir(join(dir, 'skills'), { recursive: true });
    await symlink(externalSkillDir, join(dir, 'skills', 'linked-skill'), 'dir');

    const pack = await loadPack(dir);
    expect(pack.skills.map((s) => s.name)).toEqual(['linked-skill']);
  });
});

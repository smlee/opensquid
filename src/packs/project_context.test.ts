/**
 * T-project-context — the lightweight per-project context+settings loader.
 *
 * Covers the spec acceptance (docs/tasks/T-project-context.md):
 *  - splitFrontmatter / settingsToGuards units;
 *  - loadProjectContextPack over a REAL temp project dir (resolveProjectScopeRoot
 *    walks from the passed cwd): present/absent/malformed/prose-only;
 *  - e2e via dispatchEvent: `package_manager: pnpm` blocks npm/yarn/bun install
 *    verbs (exit 2) but NOT a prose mention; the prose body surfaces as
 *    inject_context on session_start + prompt_submit, NOT on tool_call.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRegistry } from '../runtime/bootstrap.js';
import type { Event } from '../runtime/event.js';
import { dispatchEvent } from '../runtime/hooks/dispatch.js';

import {
  loadProjectContextPack,
  settingsToGuards,
  splitFrontmatter,
} from './project_context.js';

const NOOP_BACKEND = {
  init: () => Promise.resolve(),
  embed: () => Promise.resolve(null),
  recall: () => Promise.resolve([]),
  storeLesson: () => Promise.resolve(),
  deleteLesson: () => Promise.resolve({ deleted: false, forced: false }),
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osq-pctx-'));
  await mkdir(join(dir, '.opensquid'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (content: string) => writeFile(join(dir, '.opensquid', 'context.md'), content, 'utf8');

describe('splitFrontmatter', () => {
  it('splits leading YAML frontmatter from the body', () => {
    expect(splitFrontmatter('---\npackage_manager: pnpm\n---\nUse pnpm here.')).toEqual({
      frontmatter: 'package_manager: pnpm',
      body: 'Use pnpm here.',
    });
  });
  it('returns null frontmatter when there is no fence', () => {
    expect(splitFrontmatter('Just prose.\n')).toEqual({ frontmatter: null, body: 'Just prose.\n' });
  });
  it('treats an unterminated fence as all-body (no crash)', () => {
    const raw = '---\npackage_manager: pnpm\nstill going';
    expect(splitFrontmatter(raw)).toEqual({ frontmatter: null, body: raw });
  });
  it('handles a frontmatter-only file (empty body)', () => {
    expect(splitFrontmatter('---\npackage_manager: pnpm\n---\n')).toEqual({
      frontmatter: 'package_manager: pnpm',
      body: '',
    });
  });
});

describe('settingsToGuards', () => {
  it('pnpm → blocks every OTHER manager install verb, never pnpm itself', () => {
    const guards = settingsToGuards({ package_manager: 'pnpm' });
    const names = guards.map((g) => g.name);
    expect(names).toContain('pm-no-npm-install');
    expect(names).toContain('pm-no-npm-i');
    expect(names).toContain('pm-no-npm-ci');
    expect(names).toContain('pm-no-npm-add');
    expect(names).toContain('pm-no-yarn-add');
    expect(names).toContain('pm-no-bun-add');
    expect(names.some((n) => n.startsWith('pm-no-pnpm-'))).toBe(false);
    // structural detect, block level
    for (const g of guards) {
      expect(g.detect?.call).toBe('command_invokes');
      expect(g.level).toBe('block');
      expect(g.on).toBe('tool_call');
      expect(g.name).toMatch(/^[a-z0-9][a-z0-9-]*$/); // guard-name schema
    }
  });
  it('no setting → no guards', () => {
    expect(settingsToGuards({})).toEqual([]);
  });
});

describe('loadProjectContextPack', () => {
  it('returns null when there is no context.md', async () => {
    expect(await loadProjectContextPack(dir)).toBeNull();
  });

  it('builds a guards skill + a prose skill from a full file', async () => {
    await write('---\npackage_manager: pnpm\n---\nThe API client lives in src/api.');
    const pack = await loadProjectContextPack(dir);
    expect(pack).not.toBeNull();
    expect(pack?.name).toBe('project-context');
    expect(pack?.scope).toBe('project');
    const skillNames = pack?.skills.map((s) => s.name).sort();
    expect(skillNames).toEqual(['project-context/context', 'project-context/guards']);
    // prose skill surfaces on session_start + prompt_submit only
    const prose = pack?.skills.find((s) => s.name === 'project-context/context');
    expect(prose?.triggers.map((t) => t.kind).sort()).toEqual(['prompt_submit', 'session_start']);
  });

  it('prose-only file → just the inject skill (no guards)', async () => {
    await write('No frontmatter — only project context prose.');
    const pack = await loadProjectContextPack(dir);
    expect(pack?.skills.map((s) => s.name)).toEqual(['project-context/context']);
  });

  it('settings-only file → just the guards skill (no prose)', async () => {
    await write('---\npackage_manager: pnpm\n---\n');
    const pack = await loadProjectContextPack(dir);
    expect(pack?.skills.map((s) => s.name)).toEqual(['project-context/guards']);
  });

  it('throws (fail loud) on an unknown frontmatter key', async () => {
    await write('---\nnot_a_setting: true\n---\nprose');
    await expect(loadProjectContextPack(dir)).rejects.toThrow(/malformed|frontmatter/i);
  });
});

describe('loadProjectContextPack — e2e via dispatchEvent', () => {
  const bash = (command: string): Event =>
    ({ kind: 'tool_call', tool: 'Bash', args: { command } }) as unknown as Event;

  it('package_manager: pnpm blocks npm/yarn/bun installs but not a prose mention', async () => {
    await write('---\npackage_manager: pnpm\n---\nUse pnpm.');
    const pack = await loadProjectContextPack(dir);
    const registry = await buildRegistry({ backend: NOOP_BACKEND });

    expect((await dispatchEvent(bash('npm install'), [pack!], registry, 'pc-1')).exitCode).toBe(2);
    expect((await dispatchEvent(bash('npm i lodash'), [pack!], registry, 'pc-2')).exitCode).toBe(2);
    expect((await dispatchEvent(bash('yarn add react'), [pack!], registry, 'pc-3')).exitCode).toBe(2);
    expect((await dispatchEvent(bash('bun add zod'), [pack!], registry, 'pc-4')).exitCode).toBe(2);
    // pnpm itself is allowed
    expect((await dispatchEvent(bash('pnpm install'), [pack!], registry, 'pc-5')).exitCode).toBe(0);
    // a prose MENTION does not false-fire (structural command_invokes)
    expect((await dispatchEvent(bash('echo "run npm install"'), [pack!], registry, 'pc-6')).exitCode).toBe(0);
    expect((await dispatchEvent(bash('grep "npm i" notes.md'), [pack!], registry, 'pc-7')).exitCode).toBe(0);
  });

  it('prose surfaces as inject_context on session_start + prompt_submit, not tool_call', async () => {
    await write('The deploy script is in scripts/deploy.sh.');
    const pack = await loadProjectContextPack(dir);
    const registry = await buildRegistry({ backend: NOOP_BACKEND });

    const ss = await dispatchEvent({ kind: 'session_start' } as unknown as Event, [pack!], registry, 'pc-ss');
    expect(ss.contextInjections.join('\n')).toMatch(/deploy script/);

    const ups = await dispatchEvent(
      { kind: 'prompt_submit', prompt: 'hi' } as unknown as Event,
      [pack!],
      registry,
      'pc-ups',
    );
    expect(ups.contextInjections.join('\n')).toMatch(/deploy script/);

    // tool_call must NOT carry the prose injection (triggers exclude it)
    const tc = await dispatchEvent(bash('ls'), [pack!], registry, 'pc-tc');
    expect(tc.contextInjections.join('\n')).not.toMatch(/deploy script/);
  });
});

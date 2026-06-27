/**
 * T-project-context (write half) — the scaffold-if-absent writer.
 *
 * Contract: create a starter context.md ONLY when none exists; NEVER overwrite a
 * user-authored file. Headline guarantee is the ROUND-TRIP — a scaffolded file is
 * read back correctly by the runtime loader.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectContextPack } from '../../packs/project_context.js';

import { composeStarter, scaffoldProjectContext } from './context_writer.js';

let dir: string; // a temp project root
let osq: string; // its .opensquid dir
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osq-ctxwriter-'));
  osq = join(dir, '.opensquid');
  await mkdir(osq, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const readCtx = () => readFile(join(osq, 'context.md'), 'utf8');

describe('composeStarter (pure)', () => {
  it('seeds the detected package manager + shows both tiers', () => {
    const out = composeStarter({ detectedPackageManager: 'pnpm' });
    expect(out).toMatch(/^---\npackage_manager: pnpm\n/);
    expect(out).toMatch(/forbid:/); // commented enforceable example
    expect(out).toMatch(/project context/i); // free-form body
  });
  it('omits the package_manager line when none detected', () => {
    const out = composeStarter({});
    expect(out).not.toMatch(/package_manager:/);
    expect(out).toMatch(/forbid:/);
  });
});

describe('scaffoldProjectContext (I/O)', () => {
  it('creates the file when absent', async () => {
    expect(await scaffoldProjectContext(osq, { detectedPackageManager: 'pnpm' })).toBe('created');
    expect(await readCtx()).toMatch(/package_manager: pnpm/);
  });

  it('NEVER overwrites an existing user-authored file', async () => {
    const mine = '---\nforbid:\n  - rm -rf /\n---\n# my notes\nThis is a Rust project.\n';
    await writeFile(join(osq, 'context.md'), mine, 'utf8');
    expect(await scaffoldProjectContext(osq, { detectedPackageManager: 'pnpm' })).toBe('exists');
    expect(await readCtx()).toBe(mine); // byte-identical — untouched
  });
});

describe('ROUND-TRIP: scaffolded file is loader-valid', () => {
  it('a seeded starter → loadProjectContextPack yields the guards skill', async () => {
    await scaffoldProjectContext(osq, { detectedPackageManager: 'pnpm' });
    const pack = await loadProjectContextPack(dir);
    expect(pack).not.toBeNull();
    expect(pack?.skills.map((s) => s.name)).toContain('project-context/guards');
  });

  it('a no-PM starter (comments only) → loads without throwing (no guards, prose only)', async () => {
    await scaffoldProjectContext(osq, {});
    const pack = await loadProjectContextPack(dir);
    // comment-only frontmatter parses to no settings → no guards; body → prose skill
    expect(pack?.skills.map((s) => s.name)).toEqual(['project-context/context']);
  });
});

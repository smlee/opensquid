/**
 * T-project-context (write half) — the managed-frontmatter writer.
 *
 * The headline guarantee is the ROUND-TRIP: a file written by the setup function
 * is read back correctly by the runtime loader (the write + read halves agree).
 * Plus the managed-block contract: owns frontmatter, PRESERVES the human's prose
 * body + unmanaged keys, `.bak` snapshot, created/updated/added.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectContextPack } from '../../packs/project_context.js';

import { composeContext, writeProjectContext } from './context_writer.js';

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

describe('composeContext (pure)', () => {
  it('no existing → frontmatter + starter body', () => {
    const out = composeContext('', { packageManager: 'pnpm' });
    expect(out).toMatch(/^---\npackage_manager: pnpm\n---\n/);
    expect(out).toMatch(/project context/i);
  });

  it('existing prose, no frontmatter → adds frontmatter, preserves prose', () => {
    const out = composeContext('Use the staging DB for tests.', { packageManager: 'pnpm' });
    expect(out).toMatch(/package_manager: pnpm/);
    expect(out).toContain('Use the staging DB for tests.');
  });

  it('existing frontmatter + prose → updates setting, preserves prose + unmanaged keys', () => {
    const existing = '---\npackage_manager: npm\ncustom_key: keep-me\n---\nHand-written notes.';
    const out = composeContext(existing, { packageManager: 'pnpm' });
    expect(out).toMatch(/package_manager: pnpm/);
    expect(out).not.toMatch(/package_manager: npm/);
    expect(out).toContain('custom_key: keep-me');
    expect(out).toContain('Hand-written notes.');
  });
});

describe('writeProjectContext (I/O)', () => {
  it('created → updated → return values + .bak snapshot', async () => {
    expect(await writeProjectContext(osq, { packageManager: 'pnpm' })).toBe('created');
    // re-run with a changed setting → updated, and .bak holds the prior content
    expect(await writeProjectContext(osq, { packageManager: 'yarn' })).toBe('updated');
    expect(await readFile(join(osq, 'context.md.bak'), 'utf8')).toMatch(/package_manager: pnpm/);
    expect(await readCtx()).toMatch(/package_manager: yarn/);
  });

  it('file existed without frontmatter → added', async () => {
    await writeFile(join(osq, 'context.md'), 'Just prose, no frontmatter.\n', 'utf8');
    expect(await writeProjectContext(osq, { packageManager: 'pnpm' })).toBe('added');
    expect(await readCtx()).toContain('Just prose, no frontmatter.');
  });

  it('re-run preserves a human-edited prose body', async () => {
    await writeProjectContext(osq, { packageManager: 'pnpm' });
    const edited = (await readCtx()).replace(/project context[\s\S]*$/, 'My own notes here.\n');
    await writeFile(join(osq, 'context.md'), edited, 'utf8');
    await writeProjectContext(osq, { packageManager: 'pnpm' }); // re-run (idempotent)
    expect(await readCtx()).toContain('My own notes here.');
  });
});

describe('ROUND-TRIP: writer output is loader-valid', () => {
  it('written file → loadProjectContextPack yields the guards skill', async () => {
    await writeProjectContext(osq, { packageManager: 'pnpm' });
    const pack = await loadProjectContextPack(dir);
    expect(pack).not.toBeNull();
    expect(pack?.skills.map((s) => s.name)).toContain('project-context/guards');
  });
});

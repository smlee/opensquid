/**
 * T-project-context (advisory tier) — install_project_context.
 *
 * Renders context.md into each DETECTED harness's project rules file: managed block
 * for shared files (AGENTS.md/CLAUDE.md), dedicated file for rule-dir targets, dedup
 * across AGENTS.md sharers, skip harnesses without an authoritative project path.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installProjectContextRules, renderProjectRulesBody } from './install_project_context.js';

let root: string; // temp project root
let osq: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'osq-projrules-'));
  osq = join(root, '.opensquid');
  home = join(root, 'home');
  await mkdir(osq, { recursive: true });
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeContext = (c: string) => writeFile(join(osq, 'context.md'), c, 'utf8');

describe('renderProjectRulesBody', () => {
  it('null when no context.md', async () => {
    expect(await renderProjectRulesBody(root)).toBeNull();
  });
  it('renders the prose body + a rules summary', async () => {
    await writeContext(
      '---\npackage_manager: pnpm\nforbid:\n  - curl\n---\nThis is a Rust project.',
    );
    const body = await renderProjectRulesBody(root);
    expect(body).toMatch(/Rust project/);
    expect(body).toMatch(/Package manager: `pnpm`/);
    expect(body).toMatch(/Do not run: `curl`/);
  });
});

describe('installProjectContextRules', () => {
  const hasBin = (names: string[]) => (n: string) => Promise.resolve(names.includes(n));

  it('no context.md → writes nothing', async () => {
    const rep = await installProjectContextRules(root, home, hasBin(['claude']), 'linux', {});
    expect(rep.written).toEqual([]);
  });

  it('writes a managed block into each detected shared file; dedups AGENTS.md sharers', async () => {
    await writeContext('---\npackage_manager: pnpm\n---\nProject notes.');
    // codex + amp both → ./AGENTS.md (dedup); claude → ./CLAUDE.md
    const rep = await installProjectContextRules(
      root,
      home,
      hasBin(['codex', 'amp', 'claude']),
      'linux',
      {},
    );
    const byHarness = Object.fromEntries(rep.written.map((w) => [w.harness, w.result]));
    // one of codex/amp writes AGENTS.md; the other dedups
    const agentsResults = [byHarness.codex, byHarness.amp].sort();
    expect(agentsResults).toEqual(['created', 'deduped']);
    expect(byHarness['claude-code']).toBe('created');

    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toMatch(/opensquid:begin/);
    expect(agents).toMatch(/Package manager: `pnpm`/);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf8')).toMatch(/Project notes/);
  });

  it('writes a dedicated file for rule-dir (file-kind) targets', async () => {
    await writeContext('Project notes.');
    // cursor detected via its `.cursor` dir under home (no bin)
    await mkdir(join(home, '.cursor'), { recursive: true });
    const rep = await installProjectContextRules(root, home, hasBin([]), 'linux', {});
    const cursor = rep.written.find((w) => w.harness === 'cursor');
    expect(cursor?.result).toBe('file');
    expect(await readFile(join(root, '.cursor', 'rules', 'opensquid.mdc'), 'utf8')).toMatch(
      /Project notes/,
    );
  });

  it('preserves the user’s own content in a shared file (managed block)', async () => {
    await writeContext('Project notes.');
    await writeFile(join(root, 'AGENTS.md'), '# My rules\nKeep me.\n', 'utf8');
    await installProjectContextRules(root, home, hasBin(['codex']), 'linux', {});
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Keep me.'); // foreign content preserved
    expect(agents).toMatch(/opensquid:begin/);
  });

  it('skips a detected harness with no authoritative project path (pi)', async () => {
    await writeContext('Project notes.');
    const rep = await installProjectContextRules(root, home, hasBin(['pi']), 'linux', {});
    expect(rep.written.find((w) => w.harness === 'pi')).toBeUndefined();
  });
});

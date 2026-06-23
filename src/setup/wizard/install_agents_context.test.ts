/** GAC.4 — installAgentsContext (block/file/manual + dedup + idempotent) and the wizard-hooks wiring (--no-agents). */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHooksWizard } from '../cli/hooks.js';
import { BLOCK_BEGIN } from './managed_block.js';
import { installAgentsContext } from './install_agents_context.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-gac4-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const noBins = (): Promise<boolean> => Promise.resolve(false);
const exists = async (p: string): Promise<boolean> =>
  readFile(p)
    .then(() => true)
    .catch(() => false);

describe('installAgentsContext (GAC.4)', () => {
  it('block: writes the managed block into a detected harness, preserving foreign content + .bak', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'CLAUDE.md'), '# my own notes\n');
    const rep = await installAgentsContext(home, noBins);
    const claude = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('# my own notes'); // foreign preserved
    expect(claude).toContain(BLOCK_BEGIN);
    expect(claude).toContain('Never guess');
    expect(await exists(join(home, '.claude', 'CLAUDE.md.bak'))).toBe(true);
    expect(rep.written.find((w) => w.harness === 'claude-code')?.result).toBe('added');
  });

  it('file: writes a dedicated opensquid.md for a file-kind harness (Roo)', async () => {
    await mkdir(join(home, '.roo'), { recursive: true });
    const rep = await installAgentsContext(home, noBins);
    expect(await readFile(join(home, '.roo', 'rules', 'opensquid.md'), 'utf8')).toContain(
      'Never guess',
    );
    expect(rep.written.find((w) => w.harness === 'roo')?.result).toBe('file');
  });

  it('manual: a marker harness (Cursor) + alwaysOffer (Trae/Warp) are collected for printing, not written', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const rep = await installAgentsContext(home, noBins);
    const manual = rep.manual.map((m) => m.harness);
    expect(manual).toContain('cursor');
    expect(manual).toContain('trae');
    expect(manual).toContain('warp');
    expect(rep.manual[0]?.block).toContain('Never guess');
  });

  it('dedup: Amp + Crush both target ~/.config/AGENTS.md → written ONCE (second is deduped)', async () => {
    await mkdir(join(home, '.config', 'crush'), { recursive: true });
    const ampBin = (n: string): Promise<boolean> => Promise.resolve(n === 'amp');
    const rep = await installAgentsContext(home, ampBin);
    const cfg = rep.written.filter((w) => w.path === join(home, '.config', 'AGENTS.md'));
    expect(cfg).toHaveLength(2); // amp + crush rows
    expect(cfg.filter((w) => w.result !== 'deduped')).toHaveLength(1); // but only ONE actual write
  });

  it('idempotent: re-running updates the block in place (identical content)', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await installAgentsContext(home, noBins);
    const first = await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    await installAgentsContext(home, noBins);
    expect(await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(first);
  });
});

describe('wizard hooks wiring (GAC.4) — auto-install + --no-agents suppress', () => {
  const deps = (h: string) => ({
    home: () => h,
    cwd: () => h,
    hasBinary: (n: string): Promise<boolean> => Promise.resolve(n === 'amp'),
    writer: () => Promise.resolve({ added: 1, replaced: 0, preserved: 0, backupPath: 'x.bak' }),
    stdout: () => undefined,
  });

  it('default (no --no-agents) → installs the baseline into a detected harness', async () => {
    await mkdir(join(home, '.config', 'crush'), { recursive: true });
    await runHooksWizard({ userOnly: true }, deps(home));
    expect(await exists(join(home, '.config', 'AGENTS.md'))).toBe(true); // amp/crush target written
  });

  it('--no-agents (agents:false) → does NOT install (target untouched)', async () => {
    await mkdir(join(home, '.config', 'crush'), { recursive: true });
    await runHooksWizard({ userOnly: true, agents: false }, deps(home));
    expect(await exists(join(home, '.config', 'AGENTS.md'))).toBe(false); // suppressed
  });
});

/** GAC.3 — registry detection: bin/dir/alwaysOffer signals, cited targets, Amp+Crush shared target. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REGISTRY, detectHarnessTargets, type ResolvedTarget } from './harness_targets.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-ht-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const byName = (rs: ResolvedTarget[], n: string): ResolvedTarget | undefined =>
  rs.find((r) => r.harness === n);
const noBins = (): Promise<boolean> => Promise.resolve(false);

describe('harness registry (GAC.3)', () => {
  it('has all 20 user-vetted rows', () => {
    expect(REGISTRY).toHaveLength(20);
  });

  it('detects a row by its config dir (Claude Code via ~/.claude)', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    const r = byName(await detectHarnessTargets(home, noBins), 'claude-code');
    expect(r?.path?.endsWith(join('.claude', 'CLAUDE.md'))).toBe(true);
  });

  it('detects a row by its binary even with no config dir (amp via hasBinary)', async () => {
    const has = (n: string): Promise<boolean> => Promise.resolve(n === 'amp');
    const r = byName(await detectHarnessTargets(home, has), 'amp');
    expect(r?.path?.endsWith(join('.config', 'AGENTS.md'))).toBe(true);
  });

  it('Amp and Crush resolve to the SAME target (~/.config/AGENTS.md) so GAC.4 can dedupe', async () => {
    await mkdir(join(home, '.config', 'crush'), { recursive: true });
    const has = (n: string): Promise<boolean> => Promise.resolve(n === 'amp');
    // injected env:{} so the XDG-honoring Crush row falls back to ~/.config regardless of the runner's
    // XDG_CONFIG_HOME — pins the dedup invariant deterministically (GAC.5).
    const res = await detectHarnessTargets(home, has, 'linux', {});
    expect(byName(res, 'amp')?.path).toBe(byName(res, 'crush')?.path);
  });

  it('alwaysOffer rows (Trae/Warp) are returned even with no marker, as manual with no path', async () => {
    const res = await detectHarnessTargets(home, noBins);
    expect(byName(res, 'trae')).toEqual({ harness: 'trae', kind: 'manual' });
    expect(byName(res, 'warp')).toEqual({ harness: 'warp', kind: 'manual' });
  });

  it('an absent harness is omitted', async () => {
    const res = await detectHarnessTargets(home, noBins);
    expect(byName(res, 'zed')).toBeUndefined(); // no ~/.config/zed, no binary probe
  });

  it('a file-kind row resolves to a dedicated opensquid.md (Cline)', async () => {
    await mkdir(join(home, 'Documents', 'Cline'), { recursive: true });
    const r = byName(await detectHarnessTargets(home, noBins), 'cline');
    expect(r?.kind).toBe('file');
    expect(r?.path?.endsWith(join('Documents', 'Cline', 'Rules', 'opensquid.md'))).toBe(true);
  });

  it('a manual-by-marker row (Cursor via ~/.cursor) is detected with no path', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const r = byName(await detectHarnessTargets(home, noBins), 'cursor');
    expect(r).toEqual({ harness: 'cursor', kind: 'manual' });
  });

  it('aider detects by its config FILE (~/.aider.conf.yml)', async () => {
    await writeFile(join(home, '.aider.conf.yml'), 'read: CONVENTIONS.md\n');
    expect(byName(await detectHarnessTargets(home, noBins), 'aider')?.kind).toBe('manual');
  });
});

describe('Windows targets (GAC.5)', () => {
  const hasZed = (n: string): Promise<boolean> => Promise.resolve(n === 'zed' || n === 'goose');
  const winEnv: NodeJS.ProcessEnv = { APPDATA: 'C:\\Users\\t\\AppData\\Roaming' };

  it('on win32, Zed resolves under the INJECTED %APPDATA% (not the AppData\\Roaming fallback)', async () => {
    const r = byName(await detectHarnessTargets(home, hasZed, 'win32', winEnv), 'zed');
    expect(r?.path).toBe(join('C:\\Users\\t\\AppData\\Roaming', 'Zed', 'AGENTS.md'));
  });

  it('on win32, Goose resolves under %APPDATA%\\Block\\goose\\config (etcetera native strategy)', async () => {
    const r = byName(await detectHarnessTargets(home, hasZed, 'win32', winEnv), 'goose');
    expect(r?.path).toBe(
      join('C:\\Users\\t\\AppData\\Roaming', 'Block', 'goose', 'config', '.goosehints'),
    );
  });

  it('Zed is detected via the `zed` binary on a Win home with no ~/.config/zed', async () => {
    const r = byName(await detectHarnessTargets(home, hasZed, 'win32', winEnv), 'zed');
    expect(r).toBeDefined(); // detected purely by bin:'zed'
  });

  it('on linux, Zed keeps its default ~/.config/zed/AGENTS.md target', async () => {
    const r = byName(await detectHarnessTargets(home, hasZed, 'linux', winEnv), 'zed');
    expect(r?.path).toBe(join(home, '.config', 'zed', 'AGENTS.md'));
  });

  it('the Amp/Crush/OpenCode trio is `.config`-literal on win32 (no winTarget; winEnv has no XDG)', async () => {
    await mkdir(join(home, '.config', 'crush'), { recursive: true });
    const has = (n: string): Promise<boolean> => Promise.resolve(n === 'amp' || n === 'opencode');
    const res = await detectHarnessTargets(home, has, 'win32', winEnv);
    // Amp + Crush share one path (deduped at install time); OpenCode is separate.
    expect(byName(res, 'amp')?.path).toBe(join(home, '.config', 'AGENTS.md'));
    expect(byName(res, 'crush')?.path).toBe(join(home, '.config', 'AGENTS.md'));
    expect(byName(res, 'opencode')?.path).toBe(join(home, '.config', 'opencode', 'AGENTS.md'));
  });
});

describe('XDG_CONFIG_HOME handling (GAC.5)', () => {
  const trio = (n: string): Promise<boolean> =>
    Promise.resolve(n === 'amp' || n === 'crush' || n === 'opencode');

  it('XDG UNSET: Amp & Crush coincide at ~/.config/AGENTS.md (→ dedup); OpenCode is separate', async () => {
    const res = await detectHarnessTargets(home, trio, 'linux', {});
    expect(byName(res, 'amp')?.path).toBe(join(home, '.config', 'AGENTS.md'));
    expect(byName(res, 'crush')?.path).toBe(join(home, '.config', 'AGENTS.md'));
    expect(byName(res, 'opencode')?.path).toBe(join(home, '.config', 'opencode', 'AGENTS.md'));
  });

  it('XDG SET: Crush & OpenCode follow $XDG; Amp stays ~/.config (ignores XDG) → Amp & Crush DIVERGE', async () => {
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/xdg' };
    const res = await detectHarnessTargets(home, trio, 'linux', env);
    expect(byName(res, 'crush')?.path).toBe(join('/xdg', 'AGENTS.md'));
    expect(byName(res, 'opencode')?.path).toBe(join('/xdg', 'opencode', 'AGENTS.md'));
    expect(byName(res, 'amp')?.path).toBe(join(home, '.config', 'AGENTS.md'));
    expect(byName(res, 'amp')?.path).not.toBe(byName(res, 'crush')?.path); // diverge → both written
  });
});

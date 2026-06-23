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
    const res = await detectHarnessTargets(home, has);
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

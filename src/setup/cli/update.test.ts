/**
 * UPD.2 (T-npm-auto-update, wg-7091e922881b) — `classifyInstall` truth
 * table (pure classifier, no fs), the load-bearing precedence pin, and the
 * `--check-only` → refreshCache merge round-trip shared with UPD.1.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readUpdateCache, refreshCache, writeUpdateCache } from '../../runtime/update_check.js';

import { classifyInstall } from './update.js';

describe('classifyInstall — truth table', () => {
  const GLOBAL = '/Users/u/.nvm/versions/node/v22.0.0/lib/node_modules';

  it('running copy IS the symlink target repo → linked-dev', () => {
    expect(
      classifyInstall({
        packageRoot: '/Users/u/projects/loop/opensquid',
        linkedRepoRoot: '/Users/u/projects/loop/opensquid',
        npmGlobalRoot: GLOBAL,
      }).kind,
    ).toBe('linked-dev');
  });

  it('precedence pin: the target repo under a global-looking path still wins linked-dev', () => {
    const m = classifyInstall({
      packageRoot: `${GLOBAL}/opensquid`,
      linkedRepoRoot: `${GLOBAL}/opensquid`,
      npmGlobalRoot: GLOBAL,
    });
    expect(m.kind).toBe('linked-dev');
  });

  it('prefix-nuance pin (spiked live): a DIFFERENT copy on a machine WITH a linked entry is NOT linked-dev', () => {
    const m = classifyInstall({
      packageRoot: '/tmp/prefix/lib/node_modules/opensquid',
      linkedRepoRoot: '/Users/u/projects/loop/opensquid',
      npmGlobalRoot: GLOBAL,
    });
    expect(m.kind).toBe('local-dep'); // refused with project-dep guidance, never mutated
  });

  it('/_npx/ path → npx', () => {
    expect(
      classifyInstall({
        packageRoot: '/Users/u/.npm/_npx/abc123/node_modules/opensquid',
        linkedRepoRoot: null,
        npmGlobalRoot: GLOBAL,
      }).kind,
    ).toBe('npx');
  });

  it('/pnpm/global/ path → pnpm-global', () => {
    expect(
      classifyInstall({
        packageRoot: '/Users/u/Library/pnpm/global/5/node_modules/opensquid',
        linkedRepoRoot: null,
        npmGlobalRoot: GLOBAL,
      }).kind,
    ).toBe('pnpm-global');
  });

  it('real path under npmGlobalRoot → npm-global', () => {
    expect(
      classifyInstall({
        packageRoot: `${GLOBAL}/opensquid`,
        linkedRepoRoot: null,
        npmGlobalRoot: GLOBAL,
      }).kind,
    ).toBe('npm-global');
  });

  it('anything else → local-dep; npm absent (nulls) never crashes', () => {
    expect(
      classifyInstall({
        packageRoot: '/work/myproject/node_modules/opensquid',
        linkedRepoRoot: null,
        npmGlobalRoot: GLOBAL,
      }).kind,
    ).toBe('local-dep');
    expect(
      classifyInstall({
        packageRoot: '/work/myproject/node_modules/opensquid',
        linkedRepoRoot: null,
        npmGlobalRoot: null,
      }).kind,
    ).toBe('local-dep');
  });

  it('Windows backslash paths are normalized before matching', () => {
    expect(
      classifyInstall({
        packageRoot: 'C:\\Users\\u\\AppData\\npm-cache\\_npx\\abc\\node_modules\\opensquid',
        linkedRepoRoot: null,
        npmGlobalRoot: null,
      }).kind,
    ).toBe('npx');
  });
});

describe('--check-only ↔ UPD.1 cache (the cross-slice round-trip)', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    home = await mkdtemp(join(tmpdir(), 'opensquid-upd2-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('refreshCache (the --check-only write path) preserves a seeded notified_at', async () => {
    const notified = '2026-06-11T11:00:00.000Z';
    await writeUpdateCache({
      latest: '0.5.400',
      checked_at: '2026-06-10T00:00:00.000Z',
      notified_at: notified,
    });
    await refreshCache('0.5.401', '2026-06-11T12:00:00.000Z');
    const after = await readUpdateCache();
    expect(after?.latest).toBe('0.5.401');
    expect(after?.notified_at).toBe(notified); // the throttle survives the refresh
  });
});

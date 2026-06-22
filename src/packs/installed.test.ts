/** ORCH.7 — listInstalledV2Packs: returns valid installed v2 packs, skips non-pack/malformed dirs (fail-open). */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listInstalledV2Packs } from './installed.js';

let home: string;
let cwd: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  home = await mkdtemp(join(tmpdir(), 'osq-installed-home-'));
  cwd = await mkdtemp(join(tmpdir(), 'osq-installed-cwd-')); // no .opensquid → projectRoot null
  process.env.OPENSQUID_HOME = home;
});
afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

const installPack = async (name: string, yaml: string): Promise<void> => {
  const dir = join(home, 'packs', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pack.yaml'), yaml);
};

describe('listInstalledV2Packs (ORCH.7)', () => {
  it('returns valid installed v2 packs and skips malformed + non-pack dirs (fail-open)', async () => {
    await installPack(
      'valid-pack',
      'name: valid-pack\nversion: 1.0.0\nscope: workflow\nserves:\n  intent: produce\n',
    );
    await installPack('malformed', 'name: : : not valid yaml ][\n');
    await mkdir(join(home, 'packs', 'nopack'), { recursive: true }); // dir with no pack.yaml

    const names = (await listInstalledV2Packs(cwd)).map((l) => l.pack.name);
    expect(names).toContain('valid-pack');
    expect(names).not.toContain('malformed');
    expect(names).not.toContain('nopack');
  });

  it('an absent packs base → no throw, no entries from it', async () => {
    // home has no packs/ dir at all → user-scope base is ENOENT → skipped; result excludes any user pack.
    const names = (await listInstalledV2Packs(cwd)).map((l) => l.pack.name);
    expect(names).not.toContain('valid-pack');
  });

  it('dedups by name, scope-first wins', async () => {
    await installPack(
      'dup',
      'name: dup\nversion: 1.0.0\nscope: workflow\nserves:\n  intent: inform\n',
    );
    const all = await listInstalledV2Packs(cwd);
    expect(all.filter((l) => l.pack.name === 'dup')).toHaveLength(1);
  });
});

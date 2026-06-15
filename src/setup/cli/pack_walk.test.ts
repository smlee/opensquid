import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { walkPacksDir } from './pack_walk.js';

let packsDir: string;
beforeEach(async () => {
  packsDir = await mkdtemp(join(tmpdir(), 'opensquid-packwalk-'));
});
afterEach(async () => {
  await rm(packsDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Create a pack dir; when `withManifest`, drop a (content-irrelevant) manifest.yaml. */
async function pack(name: string, withManifest: boolean): Promise<void> {
  const dir = join(packsDir, name);
  await mkdir(dir, { recursive: true });
  if (withManifest) await writeFile(join(dir, 'manifest.yaml'), `name: ${name}\n`, 'utf8');
}

const spyWarn = (): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('walkPacksDir (wg-a3e928b8255b — resilient installed-set scan)', () => {
  it('includes manifest-bearing packs; loadOne receives (dir, name)', async () => {
    await pack('good', true);
    const out = await walkPacksDir(packsDir, (dir, name) => Promise.resolve({ dir, name }));
    expect(out).toEqual([{ dir: join(packsDir, 'good'), name: 'good' }]);
  });

  it('SILENTLY skips a dir with no manifest.yaml — loadOne never called, no warn', async () => {
    await pack('notapack', false);
    const warn = spyWarn();
    const loadOne = vi.fn((_d: string, n: string) => Promise.resolve(n));
    const out = await walkPacksDir(packsDir, loadOne);
    expect(out).toEqual([]);
    expect(loadOne).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('WARNS + skips a manifest-bearing pack whose loadOne throws a plain Error (Zod/YAML class)', async () => {
    await pack('good', true);
    await pack('broken', true);
    const warn = spyWarn();
    const out = await walkPacksDir(packsDir, (_dir, name) =>
      name === 'broken'
        ? Promise.reject(new Error('Schema validation failed for manifest.yaml'))
        : Promise.resolve(name),
    );
    expect(out).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('broken');
  });

  it('WARNS + skips when loadOne rejects with an ENOENT-coded error (the missing-skill.yaml deeper-read case — NOT silently dropped)', async () => {
    await pack('half-built', true);
    const warn = spyWarn();
    const enoent = Object.assign(new Error("ENOENT: no such file 'skill.yaml'"), {
      code: 'ENOENT',
    });
    const out = await walkPacksDir(packsDir, () => Promise.reject(enoent));
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1); // the bug: this used to be a silent drop
  });

  it('skips dotfile dirs and non-directory entries without calling loadOne', async () => {
    await pack('.hidden', true);
    await writeFile(join(packsDir, 'loose.txt'), 'x', 'utf8');
    await pack('real', true);
    const loadOne = vi.fn((_d: string, n: string) => Promise.resolve(n));
    const out = await walkPacksDir(packsDir, loadOne);
    expect(out).toEqual(['real']);
    expect(loadOne).toHaveBeenCalledTimes(1);
  });

  it('returns [] when the packs dir itself is absent (ENOENT)', async () => {
    const out = await walkPacksDir(join(packsDir, 'does-not-exist'), () => Promise.resolve('x'));
    expect(out).toEqual([]);
  });
});

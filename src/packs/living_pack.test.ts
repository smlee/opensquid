/**
 * DOG.5 — getLivingPackVersion unit tests.
 *
 * Covers the read path against an isolated OPENSQUID_HOME tmpdir:
 *   - null when pack state dir is absent (fresh / built-in)
 *   - null when version.json is absent within state dir
 *   - returns {base, revision} when version.json is present
 *   - reflects monotonic revision bumps after appendLessonFile
 *   - propagates malformed-JSON throw from readVersionJson
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getLivingPackVersion } from './living_pack.js';
import {
  appendLessonFile,
  initPersonalRevision,
  readVersionJson,
  writeVersionJson,
} from './personal_revision.js';

let tmpHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'opensquid-living-pack-test-'));
  priorHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = tmpHome;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
});

function packStateDir(packId: string): string {
  return join(tmpHome, 'packs', packId);
}

describe('DOG.5 — getLivingPackVersion', () => {
  it('returns null when the pack state dir does NOT exist (built-in / never installed)', async () => {
    expect(await getLivingPackVersion('focused-react-19')).toBeNull();
  });

  it('returns null when the state dir exists but version.json is absent', async () => {
    await mkdir(packStateDir('mypack'), { recursive: true });
    expect(await getLivingPackVersion('mypack')).toBeNull();
  });

  it('returns {base, revision: 0} on a fresh initPersonalRevision', async () => {
    await initPersonalRevision(packStateDir('mypack'), '1.2.3');
    const r = await getLivingPackVersion('mypack');
    expect(r).toEqual({ base: '1.2.3', revision: 0 });
  });

  it('reflects revision after appendLessonFile bumps the counter', async () => {
    await initPersonalRevision(packStateDir('mypack'), '1.0.0');
    await appendLessonFile(packStateDir('mypack'), { title: 'L1', body: 'first' });
    const r = await getLivingPackVersion('mypack');
    expect(r).toEqual({ base: '1.0.0', revision: 1 });
  });

  it('monotonic across multiple appendLessonFile calls', async () => {
    await initPersonalRevision(packStateDir('mypack'), '1.0.0');
    await appendLessonFile(packStateDir('mypack'), { title: 'L1', body: 'a' });
    await appendLessonFile(packStateDir('mypack'), { title: 'L2', body: 'b' });
    await appendLessonFile(packStateDir('mypack'), { title: 'L3', body: 'c' });
    const r = await getLivingPackVersion('mypack');
    expect(r?.revision).toBe(3);
  });

  it('honors OPENSQUID_HOME override (the test seam is wired through resolvePackStateDir)', async () => {
    await initPersonalRevision(packStateDir('p'), '2.0.0');
    const r = await getLivingPackVersion('p');
    expect(r?.base).toBe('2.0.0');
    // Sanity: changing the env var swaps the read root.
    const otherHome = await mkdtemp(join(tmpdir(), 'opensquid-living-pack-other-'));
    process.env.OPENSQUID_HOME = otherHome;
    expect(await getLivingPackVersion('p')).toBeNull();
  });

  it('writeVersionJson + getLivingPackVersion round-trip preserves last_merged_vanilla via underlying read', async () => {
    const dir = packStateDir('mypack');
    await writeVersionJson(dir, {
      base_version: '1.2.0',
      personal_revision_id: 7,
      last_merged_vanilla: '1.1.0',
    });
    const r = await getLivingPackVersion('mypack');
    expect(r).toEqual({ base: '1.2.0', revision: 7 });
    // last_merged_vanilla still readable via the underlying API even though
    // getLivingPackVersion doesn't return it (intentional — DOG.5 is the
    // base.rev triple, not the full ledger).
    const full = await readVersionJson(dir);
    expect(full?.last_merged_vanilla).toBe('1.1.0');
  });

  it('throws when version.json is malformed JSON (LP.1 loud-failure contract preserved)', async () => {
    const dir = packStateDir('mypack');
    await mkdir(join(dir, 'personal_revision'), { recursive: true });
    await writeFile(join(dir, 'personal_revision', 'version.json'), '{not-json');
    await expect(getLivingPackVersion('mypack')).rejects.toThrow();
  });

  it('returns null for an unrelated pack id even when OTHER packs are installed', async () => {
    await initPersonalRevision(packStateDir('packA'), '1.0.0');
    expect(await getLivingPackVersion('packB')).toBeNull();
  });

  it('two packs installed independently report independent versions', async () => {
    await initPersonalRevision(packStateDir('p1'), '1.0.0');
    await initPersonalRevision(packStateDir('p2'), '2.0.0');
    await appendLessonFile(packStateDir('p1'), { title: 'L1', body: 'a' });
    const r1 = await getLivingPackVersion('p1');
    const r2 = await getLivingPackVersion('p2');
    expect(r1).toEqual({ base: '1.0.0', revision: 1 });
    expect(r2).toEqual({ base: '2.0.0', revision: 0 });
  });
});

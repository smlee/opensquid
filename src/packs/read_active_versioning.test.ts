/** AGF.1 (wg-01d5a9233026) — readActiveVersioning: parses a well-formed locked-prefix object from a scope's
 *  active.json, returns null on absent/malformed/unreadable, validates the strategy discriminant. A byte-for-byte
 *  sibling of readActiveVerifySuite. Over a throwaway temp scope — no live config. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActiveVersioning } from './discovery.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function scope(active: string | null): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'agf1v-'));
  dirs.push(d);
  if (active !== null) await writeFile(join(d, 'active.json'), active);
  return d;
}

describe('AGF.1 readActiveVersioning', () => {
  it('parses a well-formed locked-prefix object', async () => {
    const d = await scope(
      JSON.stringify({
        versioning: { strategy: 'locked-prefix', prefix: '0.5', bump: 'patch-per-release' },
      }),
    );
    expect(await readActiveVersioning(d)).toEqual({
      strategy: 'locked-prefix',
      prefix: '0.5',
      bump: 'patch-per-release',
    });
  });
  it('defaults bump to patch-per-release when only strategy+prefix are declared', async () => {
    const d = await scope(
      JSON.stringify({ versioning: { strategy: 'locked-prefix', prefix: '0.5' } }),
    );
    expect((await readActiveVersioning(d))?.bump).toBe('patch-per-release');
  });
  it('null for a null scope, absent active.json, an absent versioning key, a wrong strategy, and an empty prefix', async () => {
    expect(await readActiveVersioning(null)).toBeNull();
    expect(await readActiveVersioning(await scope(null))).toBeNull();
    expect(await readActiveVersioning(await scope(JSON.stringify({ packs: [] })))).toBeNull();
    expect(
      await readActiveVersioning(
        await scope(JSON.stringify({ versioning: { strategy: 'semver' } })),
      ),
    ).toBeNull();
    expect(
      await readActiveVersioning(
        await scope(JSON.stringify({ versioning: { strategy: 'locked-prefix', prefix: '  ' } })),
      ),
    ).toBeNull();
  });
  it('null on malformed json (never throws)', async () => {
    expect(await readActiveVersioning(await scope('{not json'))).toBeNull();
  });
});

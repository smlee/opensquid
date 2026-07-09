/** AGF.1 (wg-01d5a9233026) — readActiveVersioning: parses a well-formed locked-prefix object from a scope's
 *  active.json, returns null on absent/malformed/unreadable, validates the strategy discriminant. A byte-for-byte
 *  sibling of readActiveVerifySuite. Over a throwaway temp scope — no live config. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readActiveVersioning, mergeVersioning, resolveVersioning } from './discovery.js';

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

/** A throwaway scope with an active.json + an installed v2 pack (`<scope>/packs/<name>/pack.yaml`) declaring the
 *  given `versioning` default, so `resolveVersioning` exercises the real pack-load + project-over-pack merge. */
async function scopeWithPack(activeVersioning: unknown, packVersioning: unknown): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'agf1r-'));
  dirs.push(d);
  const active: Record<string, unknown> = { packs: ['vpack'] };
  if (activeVersioning !== undefined) active.versioning = activeVersioning;
  await writeFile(join(d, 'active.json'), JSON.stringify(active));
  const packDir = join(d, 'packs', 'vpack');
  await mkdir(packDir, { recursive: true });
  // A minimal foundation-only v2 pack (no fsm/serves) — enough to load + carry the `versioning` default.
  const versioningYaml =
    packVersioning === undefined
      ? ''
      : `\nversioning:\n  strategy: ${(packVersioning as { strategy: string }).strategy}\n  prefix: '${(packVersioning as { prefix: string }).prefix}'\n  bump: ${(packVersioning as { bump: string }).bump}\n`;
  await writeFile(
    join(packDir, 'pack.yaml'),
    `name: vpack\nversion: 0.0.1\nscope: workflow\nfoundation: {}\n${versioningYaml}`,
  );
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

describe('AGF.1 mergeVersioning — pure project-over-pack merge', () => {
  const packDefault = {
    strategy: 'locked-prefix' as const,
    prefix: '0.5',
    bump: 'patch-per-release' as const,
  };
  it('a project that declares only the prefix resolves strategy+bump from the pack default', () => {
    expect(mergeVersioning(packDefault, { prefix: '0.9' })).toEqual({
      strategy: 'locked-prefix',
      prefix: '0.9',
      bump: 'patch-per-release',
    });
  });
  it('a project that declares nothing (null) inherits the pack default whole', () => {
    expect(mergeVersioning(packDefault, null)).toEqual(packDefault);
  });
  it('the project OVERRIDES the pack default field-by-field (one-directional)', () => {
    expect(
      mergeVersioning(packDefault, {
        strategy: 'locked-prefix',
        prefix: '2.0',
        bump: 'patch-per-release',
      }),
    ).toEqual({ strategy: 'locked-prefix', prefix: '2.0', bump: 'patch-per-release' });
  });
  it('null pack default + a full project object still resolves (project alone suffices)', () => {
    expect(mergeVersioning(null, { strategy: 'locked-prefix', prefix: '0.5' })).toEqual({
      strategy: 'locked-prefix',
      prefix: '0.5',
      bump: 'patch-per-release',
    });
  });
  it('null when neither source yields a valid strategy/prefix (both null, or a prefix with no strategy anywhere)', () => {
    expect(mergeVersioning(null, null)).toBeNull();
    expect(mergeVersioning(null, { prefix: '0.5' })).toBeNull(); // no strategy from either source
    expect(mergeVersioning({ strategy: 'locked-prefix' }, { prefix: '  ' })).toBeNull(); // empty prefix
  });
});

describe('AGF.1 resolveVersioning — project object merged over the active pack default', () => {
  it('a project declaring only the prefix resolves strategy+bump from the PACK default (design §6)', async () => {
    const d = await scopeWithPack(
      { prefix: '0.9' },
      { strategy: 'locked-prefix', prefix: '0.5', bump: 'patch-per-release' },
    );
    expect(await resolveVersioning(d)).toEqual({
      strategy: 'locked-prefix',
      prefix: '0.9', // the human-held prefix from the project WINS over the pack default's 0.5
      bump: 'patch-per-release',
    });
  });
  it('a project that omits versioning entirely inherits the pack default whole', async () => {
    const d = await scopeWithPack(undefined, {
      strategy: 'locked-prefix',
      prefix: '0.5',
      bump: 'patch-per-release',
    });
    expect(await resolveVersioning(d)).toEqual({
      strategy: 'locked-prefix',
      prefix: '0.5',
      bump: 'patch-per-release',
    });
  });
  it('a project full object resolves even when the pack declares no default', async () => {
    const d = await scopeWithPack(
      { strategy: 'locked-prefix', prefix: '0.5', bump: 'patch-per-release' },
      undefined,
    );
    expect(await resolveVersioning(d)).toEqual({
      strategy: 'locked-prefix',
      prefix: '0.5',
      bump: 'patch-per-release',
    });
  });
  it('null when neither the project nor any pack declares versioning', async () => {
    const d = await scopeWithPack(undefined, undefined);
    expect(await resolveVersioning(d)).toBeNull();
  });
});

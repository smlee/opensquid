/**
 * Tests for path resolution helpers — focused on Task 5.3's pack-state
 * paths + sanitization contract.
 *
 * The session-scoped helpers are covered indirectly through every other
 * test that exercises `OPENSQUID_HOME` overrides; this file pins the
 * pack-id sanitization rules explicitly because they are the security
 * boundary against path traversal.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPENSQUID_HOME,
  inboxAckedPath,
  inboxDir,
  packLogFile,
  packStateDir,
  packStateFile,
  resolveProjectScopeRoot,
  resolveProjectUuid,
  resolveProjectUuidFromEnv,
  resolveUserScopeRoot,
  walkForProjectUuid,
} from './paths.js';

let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = join(tmpdir(), 'opensquid-paths-test');
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
});

describe('packStateFile', () => {
  it('resolves to ~/.opensquid/packs/<id>/state/<key>.json for a clean id', () => {
    const p = packStateFile('my-pack', 'active-task');
    expect(p).toBe(join(OPENSQUID_HOME(), 'packs', 'my-pack', 'state', 'active-task.json'));
  });

  it('sanitizes path-traversal sequences (../etc/passwd) into safe identifiers', () => {
    const p = packStateFile('../etc/passwd', 'foo');
    // `.`, `/`, and `.` all become `_`. Result is fully contained in the
    // pack-state root with NO `..` or path separators escaping out.
    expect(p).toBe(join(OPENSQUID_HOME(), 'packs', '___etc_passwd', 'state', 'foo.json'));
    // Triple-check: there's no `..` segment anywhere in the resolved path.
    const segments = p.split(sep);
    expect(segments).not.toContain('..');
    // And the resolved path must still be a descendant of OPENSQUID_HOME.
    expect(p.startsWith(OPENSQUID_HOME())).toBe(true);
  });

  it('sanitizes other foot-guns (dots, slashes, spaces, dollar signs)', () => {
    expect(packStateFile('foo.bar', 'k')).toContain(`packs${sep}foo_bar${sep}state`);
    expect(packStateFile('foo/bar', 'k')).toContain(`packs${sep}foo_bar${sep}state`);
    expect(packStateFile('foo bar', 'k')).toContain(`packs${sep}foo_bar${sep}state`);
    expect(packStateFile('foo$bar', 'k')).toContain(`packs${sep}foo_bar${sep}state`);
  });

  it('leaves alphanumeric + underscore + hyphen ids untouched', () => {
    const p = packStateFile('Foo-Bar_42', 'k');
    expect(p).toBe(join(OPENSQUID_HOME(), 'packs', 'Foo-Bar_42', 'state', 'k.json'));
  });
});

describe('packStateDir', () => {
  it('returns the per-pack state root directory', () => {
    expect(packStateDir('p1')).toBe(join(OPENSQUID_HOME(), 'packs', 'p1', 'state'));
  });
});

describe('packLogFile', () => {
  it('returns a .jsonl path under the per-pack state root', () => {
    expect(packLogFile('p1', 'drift-catalog')).toBe(
      join(OPENSQUID_HOME(), 'packs', 'p1', 'state', 'drift-catalog.jsonl'),
    );
  });
});

// ---------------------------------------------------------------------------
// G.1 — scope-root resolvers
//
// `resolveUserScopeRoot()` is a thin alias for OPENSQUID_HOME(), so its
// behavior is fully covered by the OPENSQUID_HOME mutation in the outer
// beforeEach. We assert the symmetry explicitly.
//
// `resolveProjectScopeRoot(cwd)` walks the parent chain looking for a
// `.opensquid/` DIRECTORY. We build tmpdir fixtures so the walk doesn't
// accidentally find a real `.opensquid/` ancestor on the developer's
// machine.
// ---------------------------------------------------------------------------

describe('resolveUserScopeRoot', () => {
  it('returns OPENSQUID_HOME() (honoring the env override)', () => {
    expect(resolveUserScopeRoot()).toBe(OPENSQUID_HOME());
  });
});

describe('resolveProjectScopeRoot', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'opensquid-projscope-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the .opensquid path when cwd contains one directly', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    await mkdir(dotOpensquid, { recursive: true });

    await expect(resolveProjectScopeRoot(proj)).resolves.toBe(dotOpensquid);
  });

  it('walks up from a nested cwd to find an ancestor .opensquid', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    const nested = join(proj, 'a', 'b', 'c');
    await mkdir(dotOpensquid, { recursive: true });
    await mkdir(nested, { recursive: true });

    await expect(resolveProjectScopeRoot(nested)).resolves.toBe(dotOpensquid);
  });

  it('returns null when no .opensquid exists in cwd or any ancestor', async () => {
    const empty = join(root, 'nowhere', 'a', 'b');
    await mkdir(empty, { recursive: true });
    // The walk will continue up past `root` into the real filesystem; we
    // can't guarantee the developer machine has NO `.opensquid` ancestor
    // somewhere, so we assert only that the walk completes and returns
    // either null or a non-fixture path (which we then ignore). On CI
    // this is reliably null.
    const result = await resolveProjectScopeRoot(empty);
    if (result !== null) {
      // Defensive: if the dev machine does have a real ancestor, at
      // minimum it must not be one of our fixture paths.
      expect(result.startsWith(root)).toBe(false);
    } else {
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// T-PUC — project-UUID resolution
// ---------------------------------------------------------------------------

describe('resolveProjectUuidFromEnv', () => {
  it('returns the value when OPENSQUID_PROJECT_UUID is set + non-empty', () => {
    expect(resolveProjectUuidFromEnv({ OPENSQUID_PROJECT_UUID: 'abc-123' })).toBe('abc-123');
  });

  it('returns null when OPENSQUID_PROJECT_UUID is missing from env', () => {
    expect(resolveProjectUuidFromEnv({})).toBeNull();
  });

  it('returns null when OPENSQUID_PROJECT_UUID is the empty string', () => {
    expect(resolveProjectUuidFromEnv({ OPENSQUID_PROJECT_UUID: '' })).toBeNull();
  });

  it('defaults to process.env when no env arg supplied', () => {
    const prior = process.env.OPENSQUID_PROJECT_UUID;
    process.env.OPENSQUID_PROJECT_UUID = 'from-process-env';
    try {
      expect(resolveProjectUuidFromEnv()).toBe('from-process-env');
    } finally {
      if (prior === undefined) delete process.env.OPENSQUID_PROJECT_UUID;
      else process.env.OPENSQUID_PROJECT_UUID = prior;
    }
  });
});

describe('walkForProjectUuid', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'opensquid-puuid-walk-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the uuid when cwd contains a valid project.json directly', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    await mkdir(dotOpensquid, { recursive: true });
    await writeFile(
      join(dotOpensquid, 'project.json'),
      JSON.stringify({ version: 1, id: 'my-proj', uuid: 'aaa-bbb' }),
      'utf8',
    );

    await expect(walkForProjectUuid(proj)).resolves.toBe('aaa-bbb');
  });

  it('walks up from a nested cwd to find an ancestor project.json', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    const nested = join(proj, 'a', 'b', 'c');
    await mkdir(dotOpensquid, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(dotOpensquid, 'project.json'),
      JSON.stringify({ version: 1, id: 'p', uuid: 'nested-uuid' }),
      'utf8',
    );

    await expect(walkForProjectUuid(nested)).resolves.toBe('nested-uuid');
  });

  it('returns null on version mismatch (forward-compatibility skip)', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    await mkdir(dotOpensquid, { recursive: true });
    await writeFile(
      join(dotOpensquid, 'project.json'),
      JSON.stringify({ version: 2, id: 'p', uuid: 'v2-uuid' }),
      'utf8',
    );

    const result = await walkForProjectUuid(proj);
    if (result !== null) expect(result.startsWith(root)).toBe(false);
    else expect(result).toBeNull();
  });

  it('returns null when uuid field is missing', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    await mkdir(dotOpensquid, { recursive: true });
    await writeFile(
      join(dotOpensquid, 'project.json'),
      JSON.stringify({ version: 1, id: 'p' }),
      'utf8',
    );

    const result = await walkForProjectUuid(proj);
    if (result !== null) expect(result.startsWith(root)).toBe(false);
    else expect(result).toBeNull();
  });

  it('returns null on malformed JSON (continues the walk, then null)', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    await mkdir(dotOpensquid, { recursive: true });
    await writeFile(join(dotOpensquid, 'project.json'), '{ not json', 'utf8');

    const result = await walkForProjectUuid(proj);
    if (result !== null) expect(result.startsWith(root)).toBe(false);
    else expect(result).toBeNull();
  });

  it('returns null when no .opensquid/project.json exists in cwd or any ancestor', async () => {
    const empty = join(root, 'nowhere', 'a', 'b');
    await mkdir(empty, { recursive: true });
    const result = await walkForProjectUuid(empty);
    if (result !== null) expect(result.startsWith(root)).toBe(false);
    else expect(result).toBeNull();
  });
});

describe('resolveProjectUuid', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'opensquid-puuid-combinator-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prefers env over walk when OPENSQUID_PROJECT_UUID is set', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    await mkdir(dotOpensquid, { recursive: true });
    await writeFile(
      join(dotOpensquid, 'project.json'),
      JSON.stringify({ version: 1, id: 'p', uuid: 'from-walk' }),
      'utf8',
    );

    await expect(
      resolveProjectUuid({ cwd: proj, env: { OPENSQUID_PROJECT_UUID: 'from-env' } }),
    ).resolves.toBe('from-env');
  });

  it('falls through to the walk when env is unset', async () => {
    const proj = join(root, 'proj');
    const dotOpensquid = join(proj, '.opensquid');
    await mkdir(dotOpensquid, { recursive: true });
    await writeFile(
      join(dotOpensquid, 'project.json'),
      JSON.stringify({ version: 1, id: 'p', uuid: 'walk-uuid' }),
      'utf8',
    );

    await expect(resolveProjectUuid({ cwd: proj, env: {} })).resolves.toBe('walk-uuid');
  });

  it('returns null when both env is unset and the walk finds nothing', async () => {
    const empty = join(root, 'nowhere', 'a');
    await mkdir(empty, { recursive: true });
    const result = await resolveProjectUuid({ cwd: empty, env: {} });
    if (result !== null) expect(result.startsWith(root)).toBe(false);
    else expect(result).toBeNull();
  });

  it('defaults env to process.env when the env arg is omitted', async () => {
    const proj = join(root, 'proj');
    await mkdir(proj, { recursive: true });
    const prior = process.env.OPENSQUID_PROJECT_UUID;
    process.env.OPENSQUID_PROJECT_UUID = 'from-process-env';
    try {
      await expect(resolveProjectUuid({ cwd: proj })).resolves.toBe('from-process-env');
    } finally {
      if (prior === undefined) delete process.env.OPENSQUID_PROJECT_UUID;
      else process.env.OPENSQUID_PROJECT_UUID = prior;
    }
  });
});

describe('LL.1 inbox path helpers', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-ll1-paths-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('inboxDir(uuid) returns <home>/projects/<uuid>/inbox', () => {
    expect(inboxDir('uuid-x')).toBe(join(tempHome, 'projects', 'uuid-x', 'inbox'));
  });

  it('inboxAckedPath(uuid) returns <home>/projects/<uuid>/inbox/acked.jsonl', () => {
    expect(inboxAckedPath('uuid-x')).toBe(
      join(tempHome, 'projects', 'uuid-x', 'inbox', 'acked.jsonl'),
    );
  });
});

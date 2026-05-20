/**
 * Tests for path resolution helpers — focused on Task 5.3's pack-state
 * paths + sanitization contract.
 *
 * The session-scoped helpers are covered indirectly through every other
 * test that exercises `OPENSQUID_HOME` overrides; this file pins the
 * pack-id sanitization rules explicitly because they are the security
 * boundary against path traversal.
 */

import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OPENSQUID_HOME, packLogFile, packStateDir, packStateFile } from './paths.js';

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

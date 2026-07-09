/** REL.7 (wg-01d9609648ac) — the PROJECT publish config the release flow reads. Asserts publishConfig + the
 *  publishability contract (not private, files + prepublishOnly present) + the documented NPM_TOKEN prerequisite. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  private?: boolean;
  files?: unknown[];
  scripts?: Record<string, string>;
  publishConfig?: { access?: string; registry?: string };
};

describe('REL.7 package.json publish config', () => {
  it('declares publishConfig.access=public + registry=npmjs', () => {
    expect(pkg.publishConfig?.access).toBe('public');
    expect(pkg.publishConfig?.registry).toBe('https://registry.npmjs.org');
  });

  it('is publishable (not private, files + prepublishOnly present)', () => {
    expect(pkg.private).not.toBe(true);
    expect(Array.isArray(pkg.files) && pkg.files.length > 0).toBe(true);
    expect(pkg.scripts?.prepublishOnly).toBeTypeOf('string');
  });
});

describe('REL.7 docs/release.md prerequisite', () => {
  it('documents the NPM_TOKEN human-owned secret prerequisite', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/release.md'), 'utf8');
    expect(doc).toContain('NPM_TOKEN');
    expect(doc.toLowerCase()).toContain('secret');
  });
});

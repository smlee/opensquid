import { describe, expect, it } from 'vitest';

import { PROTECTED_PREFIXES, isDocsOnly } from './protected_paths.js';

describe('protected_paths.isDocsOnly', () => {
  it('is true when every file is outside the protected (code) prefixes', () => {
    expect(isDocsOnly(['docs/x.md'])).toBe(true);
    expect(isDocsOnly(['README.md', 'CHANGELOG.md', 'docs/a/b.md'])).toBe(true);
    expect(isDocsOnly(['.github/workflows/ci.yml', 'LICENSE'])).toBe(true);
  });

  it('is false when ANY file is under a protected prefix', () => {
    expect(isDocsOnly(['src/a.ts'])).toBe(false);
    expect(isDocsOnly(['packs/p/s.yaml'])).toBe(false);
    expect(isDocsOnly(['test/t.ts'])).toBe(false);
    expect(isDocsOnly(['docs/x.md', 'src/a.ts'])).toBe(false); // mixed → code present → false
  });

  it('is false for the empty set (fail closed — nothing proves docs-only)', () => {
    expect(isDocsOnly([])).toBe(false);
  });

  it('matches by prefix, not substring (a path merely CONTAINING src/ is docs-only)', () => {
    expect(isDocsOnly(['docs/src-notes.md'])).toBe(true);
    expect(isDocsOnly(['mysrc/a.ts'])).toBe(true); // does not START with src/
  });

  it('exposes the protected prefixes as the single source of truth', () => {
    expect([...PROTECTED_PREFIXES]).toEqual(['src/', 'packs/', 'test/']);
  });
});

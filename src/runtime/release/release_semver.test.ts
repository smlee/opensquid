/** REL.2 (wg-d759463d71b3) — PURE conventional-commit parser + semver bump. No git, no I/O. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseConventionalCommit,
  validateConventionalMessage,
  bumpLevel,
  nextVersion,
  type ParsedCommit,
} from './release_semver.js';

describe('REL.2 parseConventionalCommit', () => {
  it('parses type(scope): subject', () => {
    expect(parseConventionalCommit('feat(release): add opensquid release')).toEqual({
      type: 'feat',
      scope: 'release',
      breaking: false,
      subject: 'add opensquid release',
    });
  });

  it('parses a scope-less header', () => {
    expect(parseConventionalCommit('fix: correct the guard')).toEqual({
      type: 'fix',
      scope: null,
      breaking: false,
      subject: 'correct the guard',
    });
  });

  it('flags breaking via the `!` marker', () => {
    expect(parseConventionalCommit('feat!: drop node 18')?.breaking).toBe(true);
  });

  it('flags breaking via a BREAKING CHANGE footer', () => {
    const msg = 'feat: rework api\n\nBREAKING CHANGE: the signature changed';
    expect(parseConventionalCommit(msg)?.breaking).toBe(true);
  });

  it('returns null for a non-conforming header', () => {
    expect(parseConventionalCommit('wip whatever')).toBeNull();
    expect(parseConventionalCommit('')).toBeNull();
  });

  it('does not mis-parse a multi-line body with a stray colon', () => {
    // The header is the FIRST line only; a colon in the body must not widen the parse.
    expect(parseConventionalCommit('random line\nfeat: not the header')).toBeNull();
  });
});

describe('REL.2 validateConventionalMessage (the REL.3 gate predicate)', () => {
  it('is true iff the header parses', () => {
    expect(validateConventionalMessage('fix: x')).toBe(true);
    expect(validateConventionalMessage('chore(deps): bump y')).toBe(true);
    expect(validateConventionalMessage('wip whatever')).toBe(false);
  });
});

describe('REL.2 bumpLevel', () => {
  const c = (type: string, breaking = false): ParsedCommit => ({
    type,
    scope: null,
    breaking,
    subject: 's',
  });

  it('returns the HIGHEST applicable bump', () => {
    expect(bumpLevel([c('feat'), c('fix')])).toBe('minor');
    expect(bumpLevel([c('fix')])).toBe('patch');
    expect(bumpLevel([c('feat', true), c('feat')])).toBe('major');
  });

  it('returns null when nothing is releasable', () => {
    expect(bumpLevel([c('chore'), c('docs'), c('test')])).toBeNull();
    expect(bumpLevel([])).toBeNull();
  });
});

describe('REL.2 nextVersion', () => {
  it('applies the level', () => {
    expect(nextVersion('0.5.547', 'minor')).toBe('0.6.0');
    expect(nextVersion('0.5.547', 'patch')).toBe('0.5.548');
    expect(nextVersion('0.5.547', 'major')).toBe('1.0.0');
  });

  it('returns the input unchanged for null (the no-bump signal REL.4 keys off)', () => {
    expect(nextVersion('0.5.547', null)).toBe('0.5.547');
  });
});

describe('REL.2 purity', () => {
  it('the module performs no git/fs/child_process I/O', () => {
    const src = readFileSync(join(__dirname, 'release_semver.ts'), 'utf8');
    expect(src).not.toMatch(/execFile|child_process|node:fs|from 'node:fs'/);
  });
});

/**
 * GFR.4 / E2 — the DIFF-DERIVED conditionality (`touchesExternalDependency` + helpers). Pure, zero I/O.
 */
import { describe, expect, it } from 'vitest';

import {
  isDependencyManifest,
  isThirdPartySpecifier,
  specifiersInLine,
  touchesExternalDependency,
} from './external_dependency.js';

describe('isDependencyManifest', () => {
  it('flags known manifests (case-insensitive basename)', () => {
    for (const p of [
      'package.json',
      'a/b/package.json',
      'pnpm-lock.yaml',
      'requirements.txt',
      'go.mod',
      'Cargo.toml',
      'Gemfile',
      'pyproject.toml',
    ]) {
      expect(isDependencyManifest(p)).toBe(true);
    }
  });
  it('exempts ordinary source / docs files', () => {
    for (const p of ['src/foo.ts', 'README.md', 'packages.ts', 'my-package.json.d.ts']) {
      expect(isDependencyManifest(p)).toBe(false);
    }
  });
});

describe('isThirdPartySpecifier', () => {
  it('treats bare + scoped packages as external', () => {
    expect(isThirdPartySpecifier('zod')).toBe(true);
    expect(isThirdPartySpecifier('@scope/pkg')).toBe(true);
    expect(isThirdPartySpecifier('react-dom/client')).toBe(true);
  });
  it('treats relative, alias, absolute, and node builtins as local', () => {
    for (const s of [
      './x.js',
      '../a/b.js',
      '/abs/path',
      '@/lib',
      '~/lib',
      'node:fs',
      'bun:test',
      '',
    ]) {
      expect(isThirdPartySpecifier(s)).toBe(false);
    }
  });
});

describe('specifiersInLine', () => {
  it('extracts JS/TS import + require + dynamic-import specifiers', () => {
    expect(specifiersInLine("import { z } from 'zod'")).toEqual(['zod']);
    expect(specifiersInLine("const x = require('lodash')")).toEqual(['lodash']);
    expect(specifiersInLine("await import('./local.js')")).toEqual(['./local.js']);
    expect(specifiersInLine("export { a } from '../rel.js'")).toEqual(['../rel.js']);
  });
  it('roots a Python import at its first dotted segment', () => {
    expect(specifiersInLine('import numpy.linalg')).toEqual(['numpy']);
    expect(specifiersInLine('from requests.adapters import HTTPAdapter')).toEqual(['requests']);
  });
});

describe('touchesExternalDependency', () => {
  it('is false for an empty / whitespace diff', () => {
    expect(touchesExternalDependency('')).toBe(false);
    expect(touchesExternalDependency('   \n  ')).toBe(false);
  });

  it('flags a dependency-manifest change from the file header', () => {
    const diff = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1 +1 @@',
      '+  "left-pad": "^1.0.0"',
    ].join('\n');
    expect(touchesExternalDependency(diff)).toBe(true);
  });

  it('flags a NEW third-party import added in a source file', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,3 @@',
      " import { existing } from './bar.js'",
      "+import fetch from 'node-fetch'",
      ' export const x = 1',
    ].join('\n');
    expect(touchesExternalDependency(diff)).toBe(true);
  });

  it('EXEMPTS a pure internal refactor (only relative imports + logic added)', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      " import { helper } from './helper.js'",
      '+  const y = helper(x) + 1',
      '+  return y',
    ].join('\n');
    expect(touchesExternalDependency(diff)).toBe(false);
  });

  it('EXEMPTS a docs-only change even if the prose mentions a package name', () => {
    const diff = [
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1,2 @@',
      '+We use the zod library for validation.',
    ].join('\n');
    expect(touchesExternalDependency(diff)).toBe(false);
  });

  it('EXEMPTS adding a node: builtin import (local knowledge, never over-gated)', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1,2 @@',
      "+import { readFile } from 'node:fs/promises'",
    ].join('\n');
    expect(touchesExternalDependency(diff)).toBe(false);
  });

  it('ignores a REMOVED third-party import (only added lines count)', () => {
    const diff = [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,1 @@',
      "-import _ from 'lodash'",
      ' export const x = 1',
    ].join('\n');
    expect(touchesExternalDependency(diff)).toBe(false);
  });
});

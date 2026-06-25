/** CFD.1 — the CodeIndex builder (pure indexFromFiles + helpers). */
import { describe, expect, it } from 'vitest';

import {
  indexFromFiles,
  exportedIdentifiers,
  extractBindings,
  countActiveTests,
} from './index_build.js';

describe('buildCodeIndex parsing (CFD.1)', () => {
  it('exportedIdentifiers across declaration kinds', () => {
    expect(
      exportedIdentifiers('export function foo(){}\nexport const bar = 1\nexport type T = {}'),
    ).toEqual(['foo', 'bar', 'T']);
  });

  it('extractBindings collects .set() literal keys per export function', () => {
    const src = "export function buildGuardCtx(m){ m.set('event', e); m.set('tool', t); }";
    expect(extractBindings(src)).toEqual({ buildGuardCtx: ['event', 'tool'] });
  });

  it('countActiveTests excludes .skip/.todo', () => {
    expect(
      countActiveTests("it('a',()=>{}); it.skip('b',()=>{}); test('c',()=>{}); test.todo('d')"),
    ).toBe(2);
  });

  it('indexFromFiles: tests indexed; importGraph reaches via entrypoint imports', () => {
    const files = [
      { path: 'src/runtime/hooks/pre-tool-use.ts', content: "import { x } from '../mid.js';" },
      { path: 'src/runtime/mid.ts', content: 'export function x(){}' },
      { path: 'src/runtime/lonely.ts', content: 'export function onStateEntry(){}' },
      { path: 'src/runtime/a.test.ts', content: "it('t',()=>{})" },
    ];
    const ix = indexFromFiles(files);
    expect(ix.tests['src/runtime/a.test.ts']).toEqual({ activeCount: 1 });
    expect(ix.modules).toContain('mid');
    expect(ix.importGraph.reaches(['pre-tool-use'], 'x')).toBe(true); // pre-tool-use → mid (defines x)
    expect(ix.importGraph.reaches(['pre-tool-use'], 'onStateEntry')).toBe(false); // lonely not imported (dormant)
  });
});

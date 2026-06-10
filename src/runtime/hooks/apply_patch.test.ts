/**
 * CHS.2 — parseApplyPatch: add/update/delete/multi/none + content byte-pins.
 */

import { describe, expect, it } from 'vitest';

import { parseApplyPatch } from './apply_patch.js';

const ADD = [
  '*** Begin Patch',
  '*** Add File: src/new-file.ts',
  '+export const x = 1;',
  '+export const y = 2;',
  '*** End Patch',
].join('\n');

const UPDATE = [
  '*** Begin Patch',
  '*** Update File: docs/tasks/T-x.md',
  '@@',
  ' context line',
  '-old line',
  '+new line',
  '*** End Patch',
].join('\n');

describe('parseApplyPatch', () => {
  it('Add File → true final content (the + lines, stripped)', () => {
    const [f] = parseApplyPatch(ADD);
    expect(f?.path).toBe('src/new-file.ts');
    expect(f?.kind).toBe('add');
    expect(f?.content).toBe('export const x = 1;\nexport const y = 2;');
  });

  it('Update File → labeled hunk diff (first line is the explicit marker)', () => {
    const [f] = parseApplyPatch(UPDATE);
    expect(f?.path).toBe('docs/tasks/T-x.md');
    expect(f?.kind).toBe('update');
    expect(f?.content.startsWith('<apply_patch update — content below is the hunk diff')).toBe(
      true,
    );
    expect(f?.content).toContain('-old line');
    expect(f?.content).toContain('+new line');
  });

  it('multi-file patch → one entry per file, order preserved', () => {
    const multi = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+1',
      '*** Update File: b.md',
      '+2',
      '*** Delete File: c.txt',
      '*** End Patch',
    ].join('\n');
    const out = parseApplyPatch(multi);
    expect(out.map((f) => f.path)).toEqual(['a.ts', 'b.md', 'c.txt']);
    expect(out.map((f) => f.kind)).toEqual(['add', 'update', 'delete']);
  });

  it('path with spaces survives', () => {
    const [f] = parseApplyPatch('*** Add File: dir with space/file name.md\n+x');
    expect(f?.path).toBe('dir with space/file name.md');
  });

  it('no markers → [] (fail-open passthrough)', () => {
    expect(parseApplyPatch('just some text\nno markers here')).toEqual([]);
    expect(parseApplyPatch('')).toEqual([]);
  });
});

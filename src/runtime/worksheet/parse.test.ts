/** T-scope-worksheet — parse seam: parseWorksheetContent, titleOf, writeWorksheetFile round-trip. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseWorksheet,
  parseWorksheetContent,
  titleOf,
  worksheetPath,
  writeWorksheetFile,
} from './parse.js';

const single =
  '# Worksheet — T-foo\n\n```yaml\nmode: single\nscopes:\n  - id: T-foo\n    summary: do foo\norder:\n  - T-foo\n```\n';

describe('parseWorksheetContent', () => {
  it('a valid single worksheet → parsed Worksheet', () => {
    const r = parseWorksheetContent(single);
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.mode).toBe('single');
  });

  it('no ```yaml fence → error', () => {
    const r = parseWorksheetContent('# just prose, no fence');
    expect('error' in r && r.error).toMatch(/no .*authored block/);
  });

  it('malformed YAML → error', () => {
    const r = parseWorksheetContent('```yaml\n: : :\nmode: [unterminated\n```');
    expect('error' in r).toBe(true);
  });

  it('schema-invalid (batch scope missing issue) → error', () => {
    const md =
      '```yaml\nmode: batch\nscopes:\n  - id: a\n    summary: sa\n  - id: b\n    summary: sb\norder: [a, b]\n```';
    expect('error' in parseWorksheetContent(md)).toBe(true);
  });
});

describe('titleOf', () => {
  it('extracts the first H1', () => expect(titleOf('# My Title\n\nbody')).toBe('My Title'));
  it('falls back to the slug when no H1', () =>
    expect(titleOf('no heading', 'T-foo')).toBe('T-foo'));
});

describe('writeWorksheetFile + parseWorksheet round-trip', () => {
  let home: string;
  const saved = process.env.OPENSQUID_HOME;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'opensquid-ws-parse-'));
    process.env.OPENSQUID_HOME = home;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  it('writes under <home>/worksheets and re-parses identically', () => {
    const path = writeWorksheetFile('T-foo', {
      mode: 'single',
      scopes: [{ id: 'T-foo', summary: 'do foo' }],
      order: ['T-foo'],
    });
    expect(path).toBe(worksheetPath('T-foo'));
    expect(path.startsWith(join(home, 'worksheets'))).toBe(true);
    const r = parseWorksheet(path);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.mode).toBe('single');
      expect(r.scopes[0]?.id).toBe('T-foo');
      expect(r.order).toEqual(['T-foo']);
    }
  });
});

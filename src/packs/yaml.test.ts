/**
 * Tests for the YAML parser layer (`yaml.ts`).
 *
 * Coverage matches Task 2.2 spec §"Test fixtures" + acceptance criteria:
 *   1. comment round-trip preservation (file path → parseDocument → write)
 *   2. duplicate-key rejection (probed in post-research; yaml@2.9.0 fires
 *      DUPLICATE_KEY under `strict: true` natively)
 *   3. schema mismatch surfaces field path via Zod error message
 *   4. malformed YAML (unclosed quote) surfaces line number
 *   5. parseYamlString happy-path with the real Manifest schema
 *
 * Each filesystem test runs in `os.tmpdir()` with a unique filename so tests
 * stay independent + parallel-safe under vitest's default worker model.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Manifest } from './schemas/manifest.js';
import { parseYamlFile, parseYamlString, serializeYamlDocument } from './yaml.js';

const Foo = z.object({ foo: z.string() });

describe('parseYamlFile + serializeYamlDocument', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-yaml-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('preserves leading comments when round-tripping through the Document API', async () => {
    const src = '# leading comment\nfoo: bar\n';
    const path = join(dir, 'in.yaml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, src, 'utf8');

    const { data, document } = await parseYamlFile(path, Foo);
    expect(data).toEqual({ foo: 'bar' });

    const outPath = join(dir, 'out.yaml');
    await serializeYamlDocument(outPath, document);
    const written = await readFile(outPath, 'utf8');
    expect(written).toContain('# leading comment');
    expect(written).toContain('foo: bar');
  });

  it('throws on duplicate top-level keys (yaml v2 strict-mode catches this)', async () => {
    const src = 'foo: a\nfoo: b\n';
    const path = join(dir, 'dup.yaml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, src, 'utf8');

    await expect(parseYamlFile(path, Foo)).rejects.toThrow(/dup\.yaml/);
    await expect(parseYamlFile(path, Foo)).rejects.toThrow(/unique/i);
  });

  it('throws with the schema field path when YAML shape mismatches Zod schema', async () => {
    const src = 'foo: 1\n'; // foo is number, schema expects string
    const path = join(dir, 'shape.yaml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, src, 'utf8');

    await expect(parseYamlFile(path, Foo)).rejects.toThrow(/shape\.yaml/);
    // Zod error message carries "foo" in the path
    await expect(parseYamlFile(path, Foo)).rejects.toThrow(/foo/);
  });

  it('throws with a line reference on malformed YAML (unclosed quote)', async () => {
    const src = 'foo: "unclosed\n';
    const path = join(dir, 'bad.yaml');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, src, 'utf8');

    await expect(parseYamlFile(path, Foo)).rejects.toThrow(/bad\.yaml/);
    // yaml v2 reports `line N, column M`; for an unclosed quote on line 1 it
    // points at the newline (line 2 col 1). The contract we assert is that
    // SOME line reference appears — not its exact value.
    await expect(parseYamlFile(path, Foo)).rejects.toThrow(/line \d+/);
  });
});

describe('parseYamlString', () => {
  it('parses the minimum-viable 4-field manifest from the design doc', () => {
    const src = [
      'name: my-first-pack',
      'version: 0.1.0',
      'scope: workflow',
      'goal: ship verified work',
      '',
    ].join('\n');

    const { data } = parseYamlString(src, Manifest, '<minimum-viable>');
    expect(data.name).toBe('my-first-pack');
    expect(data.version).toBe('0.1.0');
    expect(data.scope).toBe('workflow');
    expect(data.goal).toBe('ship verified work');
    // defaults from Manifest schema (Task 2.1) fill in
    expect(data.description).toBe('');
    expect(data.requires).toEqual([]);
    expect(data.evolves).toBe(true);
  });

  it('labels errors with the supplied ctx when no file path is involved', () => {
    expect(() => parseYamlString('foo: "unclosed', Foo, '<stdin>')).toThrow(/<stdin>/);
  });
});

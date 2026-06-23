/** GAC.2 — managed-block writer: append/replace/idempotent + marker edge cases + atomic .bak. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BLOCK_BEGIN, BLOCK_END, projectManagedBlock, writeManagedBlock } from './managed_block.js';

const BODY = 'hello\nworld';
const blockCount = (s: string): number => s.split(BLOCK_BEGIN).length - 1;

describe('projectManagedBlock (GAC.2) — pure', () => {
  it('appends a block when absent, preserving foreign content (exactly one block)', () => {
    const out = projectManagedBlock('# my file\n\nforeign line\n', BODY);
    expect(out).toContain('# my file');
    expect(out).toContain('foreign line');
    expect(blockCount(out)).toBe(1);
    expect(out).toContain(`${BLOCK_BEGIN}\nhello\nworld\n${BLOCK_END}`);
  });

  it('replaces the block in place, preserving foreign before AND after, no duplication', () => {
    const existing = `before\n${BLOCK_BEGIN}\nOLD\n${BLOCK_END}\nafter\n`;
    const out = projectManagedBlock(existing, BODY);
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('OLD');
    expect(blockCount(out)).toBe(1);
  });

  it('is idempotent — running twice yields identical output', () => {
    const once = projectManagedBlock('foreign\n', BODY);
    expect(projectManagedBlock(once, BODY)).toBe(once);
  });

  it('a BEGIN with no END appends a fresh block (malformed marker, no corruption)', () => {
    const existing = `foreign\n${BLOCK_BEGIN}\ndangling, no end marker\n`;
    const out = projectManagedBlock(existing, BODY);
    expect(out).toContain('dangling, no end marker'); // foreign (incl. the stray BEGIN) preserved
    expect(out.endsWith(`${BLOCK_BEGIN}\nhello\nworld\n${BLOCK_END}\n`)).toBe(true);
  });

  it('with two blocks, only the first is replaced (we never emit >1 of our own)', () => {
    const existing = `${BLOCK_BEGIN}\nA\n${BLOCK_END}\nmid\n${BLOCK_BEGIN}\nB\n${BLOCK_END}\n`;
    const out = projectManagedBlock(existing, BODY);
    expect(out).toContain('hello\nworld'); // first replaced
    expect(out).toContain('B'); // second left intact (non-greedy)
  });

  it('a marker substring sitting in foreign prose is not corrupted', () => {
    const existing =
      'docs mention <!-- opensquid:begin (managed - do not edit) --> inline? no end here.\n';
    const out = projectManagedBlock(existing, BODY);
    expect(out).toContain('docs mention'); // foreign prose retained
  });
});

describe('writeManagedBlock (GAC.2) — atomic + .bak', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'osq-mb-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ENOENT → created (no .bak)', async () => {
    const p = join(dir, 'a', 'CLAUDE.md');
    expect(await writeManagedBlock(p, BODY)).toBe('created');
    expect(await readFile(p, 'utf8')).toContain(BLOCK_BEGIN);
    await expect(readFile(`${p}.bak`, 'utf8')).rejects.toThrow();
  });

  it('existing without block → added + .bak snapshot of the original', async () => {
    const p = join(dir, 'CLAUDE.md');
    await writeFile(p, '# user content\n');
    expect(await writeManagedBlock(p, BODY)).toBe('added');
    expect(await readFile(p, 'utf8')).toContain('# user content');
    expect(await readFile(`${p}.bak`, 'utf8')).toBe('# user content\n');
  });

  it('existing with block → updated + .bak', async () => {
    const p = join(dir, 'CLAUDE.md');
    await writeManagedBlock(p, 'v1');
    expect(await writeManagedBlock(p, 'v2')).toBe('updated');
    const out = await readFile(p, 'utf8');
    expect(out).toContain('v2');
    expect(out).not.toContain('v1');
    expect(blockCount(out)).toBe(1);
  });
});

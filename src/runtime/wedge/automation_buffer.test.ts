/**
 * Tests for the automation buffer (Task 7.2).
 *
 * Acceptance per phase-7-wedge-gate.md §"Task 7.2":
 *  - 4 categories supported (potential-lessons / keep-as-context /
 *    preferences / new-rag-pointers).
 *  - Atomic write (tmp + rename).
 *  - Append-only (no in-place edit).
 *  - BUFFER.md index updated on each write.
 *  - Walk yields in category order, timestamp-sorted within each.
 *  - Empty buffer → walk yields nothing.
 *  - ≥ 5 tests.
 *
 * Strategy: per-test `OPENSQUID_HOME` temp dir.
 */

import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendBufferEntry,
  bufferDir,
  walkBuffer,
  type BufferCategory,
  type BufferEntry,
} from './automation_buffer.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = join(tmpdir(), `opensquid-buffer-${Math.random().toString(36).slice(2, 10)}`);
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function makeEntry(
  category: BufferCategory,
  id: string,
  timestamp: string,
  body = 'body content',
  sourceContext = 'source ctx line',
): BufferEntry {
  return {
    id,
    category,
    body,
    frontmatter: {
      timestamp,
      proposedCategory: category,
      sourceContext,
      confidence: 0.8,
    },
  };
}

describe('appendBufferEntry', () => {
  it('populates all 4 category subdirs + BUFFER.md', async () => {
    const sessionId = 'sess-1';
    const categories: BufferCategory[] = [
      'potential-lessons',
      'keep-as-context',
      'preferences',
      'new-rag-pointers',
    ];
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i]!;
      await appendBufferEntry(sessionId, makeEntry(cat, `e-${i}`, `2026-05-19T10:00:0${i}.000Z`));
    }
    for (const cat of categories) {
      const files = await readdir(join(bufferDir(sessionId), cat));
      expect(files).toHaveLength(1);
    }
    const idx = await readFile(join(bufferDir(sessionId), 'BUFFER.md'), 'utf8');
    for (const cat of categories) {
      expect(idx).toContain(`${cat}/`);
    }
    // 4 lines in the index — one per entry.
    expect(idx.split('\n').filter((l) => l.startsWith('- [')).length).toBe(4);
  });

  it('atomic write leaves no tmp file on success', async () => {
    const sessionId = 'sess-2';
    await appendBufferEntry(
      sessionId,
      makeEntry('potential-lessons', 'e-1', '2026-05-19T10:00:00.000Z'),
    );
    const files = await readdir(join(bufferDir(sessionId), 'potential-lessons'));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toHaveLength(1);
  });

  it('round-trips frontmatter via walkBuffer (including multiline sourceContext)', async () => {
    const sessionId = 'sess-3';
    const multiline = 'line one\nline two\nline three';
    await appendBufferEntry(
      sessionId,
      makeEntry('preferences', 'pref-1', '2026-05-19T10:00:00.000Z', 'pref body', multiline),
    );
    const collected: BufferEntry[] = [];
    for await (const e of walkBuffer(sessionId)) collected.push(e);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.frontmatter.sourceContext).toBe(multiline);
    expect(collected[0]?.frontmatter.confidence).toBe(0.8);
    expect(collected[0]?.body).toBe('pref body');
    expect(collected[0]?.id).toBe('pref-1');
  });
});

describe('walkBuffer', () => {
  it('yields entries in category order, then chronological within category', async () => {
    const sessionId = 'sess-walk';
    // Write out-of-order to assert sort.
    await appendBufferEntry(
      sessionId,
      makeEntry('keep-as-context', 'k1', '2026-05-19T10:00:00.000Z'),
    );
    await appendBufferEntry(
      sessionId,
      makeEntry('potential-lessons', 'p2', '2026-05-19T10:00:02.000Z'),
    );
    await appendBufferEntry(
      sessionId,
      makeEntry('potential-lessons', 'p1', '2026-05-19T10:00:01.000Z'),
    );
    await appendBufferEntry(sessionId, makeEntry('preferences', 'pf1', '2026-05-19T10:00:00.000Z'));
    await appendBufferEntry(
      sessionId,
      makeEntry('new-rag-pointers', 'r1', '2026-05-19T10:00:00.000Z'),
    );

    const order: string[] = [];
    for await (const e of walkBuffer(sessionId)) order.push(`${e.category}/${e.id}`);

    // potential-lessons p1 (10:00:01) then p2 (10:00:02), then keep-as-context,
    // then preferences, then new-rag-pointers.
    expect(order).toEqual([
      'potential-lessons/p1',
      'potential-lessons/p2',
      'keep-as-context/k1',
      'preferences/pf1',
      'new-rag-pointers/r1',
    ]);
  });

  it('empty buffer yields no entries', async () => {
    const sessionId = 'sess-empty';
    const collected: BufferEntry[] = [];
    for await (const e of walkBuffer(sessionId)) collected.push(e);
    expect(collected).toHaveLength(0);
  });

  it('skips stray .tmp files (simulated crash mid-write)', async () => {
    const sessionId = 'sess-crash';
    // Simulate a crash: tmp file exists, canonical does not.
    const dir = join(bufferDir(sessionId), 'potential-lessons');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '2026-05-19T10-00-00.000Z_orphan.md.tmp'),
      '---\nid: orphan\ntimestamp: 2026-05-19T10:00:00.000Z\n---\n\nbody\n',
      'utf8',
    );
    // Now legitimate entry alongside.
    await appendBufferEntry(
      sessionId,
      makeEntry('potential-lessons', 'real', '2026-05-19T10:00:01.000Z'),
    );

    const collected: BufferEntry[] = [];
    for await (const e of walkBuffer(sessionId)) collected.push(e);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.id).toBe('real');

    // Tmp file still on disk (we never clean it up here; recovery is manual).
    const files = await readdir(dir);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(true);
  });

  it('append-only: re-writing same id produces a second file (does not overwrite)', async () => {
    // The contract is append-only — appending the same id with a new
    // timestamp creates a distinct file. (Same timestamp + id intentionally
    // overwrites, since that is a true duplicate.)
    const sessionId = 'sess-append';
    await appendBufferEntry(
      sessionId,
      makeEntry('potential-lessons', 'same-id', '2026-05-19T10:00:00.000Z', 'v1'),
    );
    await appendBufferEntry(
      sessionId,
      makeEntry('potential-lessons', 'same-id', '2026-05-19T10:00:01.000Z', 'v2'),
    );
    const files = await readdir(join(bufferDir(sessionId), 'potential-lessons'));
    expect(files).toHaveLength(2);
    // BUFFER.md has two index lines.
    const idx = await readFile(join(bufferDir(sessionId), 'BUFFER.md'), 'utf8');
    expect(idx.split('\n').filter((l) => l.startsWith('- [')).length).toBe(2);
    expect(existsSync(join(bufferDir(sessionId), 'BUFFER.md'))).toBe(true);
  });
});

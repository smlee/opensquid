/**
 * DOG.3 — seed_lessons_ingest unit tests.
 *
 * Covers: empty input, single-seed ingest call shape (description/body/
 * authored_by/pack_id/external_id/seed_as_promoted), UPSERT idempotency
 * (engine returns updated:true → skipped), per-seed error isolation
 * (one failure does not block subsequent seeds), engine-down fallback
 * (failures collected, never thrown), external_id determinism.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ingestSeedLessons, makeExternalId } from './seed_lessons_ingest.js';
import type { SeedLesson } from './schemas/manifest.js';
import type { EngineClient } from '../engine/client.js';
import type { LessonCreateParams, LessonCreateResult } from '../engine/types.js';

interface FakeEngine {
  engine: EngineClient;
  spy: ReturnType<typeof vi.fn<(p: LessonCreateParams) => Promise<LessonCreateResult>>>;
}

// Inline-body seeds never read packDir; a constant suffices for those calls.
const PACK_DIR = join(tmpdir(), 'seed-ingest-inline');

function fakeEngine(impl: (p: LessonCreateParams) => Promise<LessonCreateResult>): FakeEngine {
  const spy = vi.fn(impl);
  const engine = { lessonCreate: spy } as unknown as EngineClient;
  return { engine, spy };
}

function seed(overrides: Partial<SeedLesson> = {}): SeedLesson {
  return {
    title: 'use Server Components by default',
    body: 'In React 19, every component server-renders by default.',
    scope: 'user',
    tags: ['react-19'],
    ...overrides,
  };
}

function lessonResult(overrides: Partial<LessonCreateResult> = {}): LessonCreateResult {
  return {
    id: 'lesson-1',
    status: 'promoted',
    authored_by: 'pack',
    created_at: '2026-05-30T00:00:00Z',
    updated: false,
    ...overrides,
  };
}

describe('DOG.3 — ingestSeedLessons', () => {
  it('returns zero-counts when seeds is empty + makes NO engine call', async () => {
    const f = fakeEngine(() => Promise.resolve(lessonResult()));
    const r = await ingestSeedLessons('p', '0.1.0', [], f.engine, PACK_DIR);
    expect(r).toEqual({ ingested: 0, skipped: 0, failed: [] });
    expect(f.spy).not.toHaveBeenCalled();
  });

  it('invokes engine.lessonCreate with pack-authored shape (authored_by + pack_id + external_id + seed_as_promoted)', async () => {
    const f = fakeEngine(() => Promise.resolve(lessonResult()));
    await ingestSeedLessons('mypack', '0.2.3', [seed()], f.engine, PACK_DIR);
    expect(f.spy).toHaveBeenCalledTimes(1);
    const arg = f.spy.mock.calls[0]![0];
    expect(arg.description).toBe('use Server Components by default');
    expect(arg.body).toBe('In React 19, every component server-renders by default.');
    expect(arg.authored_by).toBe('pack');
    expect(arg.pack_id).toBe('mypack');
    expect(arg.seed_as_promoted).toBe(true);
    expect(arg.external_id).toMatch(/^pack-seed:[a-f0-9]{24}$/);
  });

  it('engine `updated: false` increments ingested', async () => {
    const f = fakeEngine(() => Promise.resolve(lessonResult({ updated: false })));
    const r = await ingestSeedLessons('p', '0.1.0', [seed()], f.engine, PACK_DIR);
    expect(r.ingested).toBe(1);
    expect(r.skipped).toBe(0);
  });

  it('engine `updated: true` increments skipped (UPSERT hit = idempotent re-ingest)', async () => {
    const f = fakeEngine(() => Promise.resolve(lessonResult({ updated: true })));
    const r = await ingestSeedLessons('p', '0.1.0', [seed()], f.engine, PACK_DIR);
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('per-seed error isolation: one rejection does not abort the rest', async () => {
    let n = 0;
    const f = fakeEngine(() => {
      n += 1;
      if (n === 2) return Promise.reject(new Error('engine blew up on seed 2'));
      return Promise.resolve(lessonResult());
    });
    const r = await ingestSeedLessons(
      'p',
      '0.1.0',
      [seed({ title: 'a' }), seed({ title: 'b' }), seed({ title: 'c' })],
      f.engine,
      PACK_DIR,
    );
    expect(r.ingested).toBe(2);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.title).toBe('b');
    expect(r.failed[0]?.error).toMatch(/engine blew up/);
  });

  it('engine totally absent (every call throws) → all failures collected, never thrown', async () => {
    const f = fakeEngine(() => Promise.reject(new Error('connection refused')));
    const r = await ingestSeedLessons(
      'p',
      '0.1.0',
      [seed({ title: 'a' }), seed({ title: 'b' })],
      f.engine,
      PACK_DIR,
    );
    expect(r.ingested).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.failed).toHaveLength(2);
    expect(r.failed.every((ff) => ff.error.includes('connection refused'))).toBe(true);
  });

  it('external_id is deterministic for the same (pack, version, title) tuple', () => {
    const a = makeExternalId('mypack', '0.2.0', 'X');
    const b = makeExternalId('mypack', '0.2.0', 'X');
    expect(a).toBe(b);
    expect(a).toMatch(/^pack-seed:[a-f0-9]{24}$/);
  });

  it('external_id differs across pack name / version / title', () => {
    const base = makeExternalId('p', '0.1.0', 'T');
    expect(makeExternalId('q', '0.1.0', 'T')).not.toBe(base);
    expect(makeExternalId('p', '0.2.0', 'T')).not.toBe(base);
    expect(makeExternalId('p', '0.1.0', 'U')).not.toBe(base);
  });

  it('ingests THREE seeds, mixed `updated` flags → counts split correctly', async () => {
    const updates = [false, true, false];
    let i = 0;
    const f = fakeEngine(() => Promise.resolve(lessonResult({ updated: updates[i++]! })));
    const r = await ingestSeedLessons(
      'p',
      '0.1.0',
      [seed({ title: 'a' }), seed({ title: 'b' }), seed({ title: 'c' })],
      f.engine,
      PACK_DIR,
    );
    expect(r.ingested).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.failed).toEqual([]);
  });
  it('body_path: reads the lesson body from a pack-relative file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-bp-'));
    await mkdir(join(dir, 'lessons', 'x'), { recursive: true });
    await writeFile(
      join(dir, 'lessons', 'x', 'lesson.md'),
      'BODY FROM FILE — long enough.\n',
      'utf8',
    );
    const f = fakeEngine(() => Promise.resolve(lessonResult()));
    const r = await ingestSeedLessons(
      'p',
      '0.1.0',
      [{ title: 't', body_path: 'lessons/x/lesson.md', scope: 'user', tags: [] }],
      f.engine,
      dir,
    );
    expect(r.ingested).toBe(1);
    expect(f.spy.mock.calls[0]![0].body).toBe('BODY FROM FILE — long enough.');
    await rm(dir, { recursive: true, force: true });
  });

  it('body_path: a traversal escape is isolated as a per-seed failure (not thrown)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-bp-'));
    const f = fakeEngine(() => Promise.resolve(lessonResult()));
    const r = await ingestSeedLessons(
      'p',
      '0.1.0',
      [{ title: 't', body_path: '../escape.md', scope: 'user', tags: [] }],
      f.engine,
      dir,
    );
    expect(r.ingested).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.error).toMatch(/escapes the pack dir/);
    await rm(dir, { recursive: true, force: true });
  });
});

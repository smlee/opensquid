/**
 * Tests for the wedge lesson lifecycle store (retire-Rust RES-3b). Uses a tmp libSQL file + tmp
 * source dir. Covers: store-owned created_at (the moat inversion), promote block/pass via the gate,
 * captureFeedback/recordApplied bumps + idempotent set-add, recall shape, and table separation.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { wedgeLessonStore, PromotionBlockedError, type WedgeLessonStore } from './store.js';

let dir: string;
let store: WedgeLessonStore;
let clock: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wedge-'));
  clock = '2026-06-08T00:00:00.000Z';
  store = wedgeLessonStore({
    dbUrl: `file:${join(dir, 'wg.db')}`,
    sourceDir: join(dir, 'lessons'),
    nowIso: () => clock,
  });
  await store.init();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Create a lesson that, after enough feedback/applied, would satisfy every gate. */
async function makeLesson(): Promise<string> {
  const { id } = await store.createLesson({
    description: 'use pnpm not npm',
    body: 'npm corrupts the workspace; always pnpm',
    evidenceRefs: ['mem-1'],
  });
  return id;
}

describe('wedgeLessonStore', () => {
  it('createLesson sets store-owned created_at (moat) + pending + counters 0', async () => {
    const out = await store.createLesson({ description: 'd', body: 'b' });
    expect(out.status).toBe('pending');
    expect(out.createdAt).toBe(clock); // store clock, never caller-supplied
    expect(out.id).toMatch(/^les-[0-9a-f]{16}$/);
    // per-file source written under pending/
    const raw = await readFile(join(dir, 'lessons', 'pending', `${out.id}.md`), 'utf8');
    const fm = parseYaml(raw.slice(4, raw.indexOf('\n---\n', 4) + 1)) as Record<string, unknown>;
    expect(fm.status).toBe('pending');
    expect(fm.created_at).toBe(clock);
    expect(fm.applied_count).toBe(0);
  });

  it('promoteLesson THROWS PromotionBlockedError (kebab prefixes) for a fresh lesson', async () => {
    const id = await makeLesson(); // 0 applied, no signals, < 24h → multiple blocks
    await expect(store.promoteLesson(id)).rejects.toBeInstanceOf(PromotionBlockedError);
    try {
      await store.promoteLesson(id);
    } catch (e) {
      const reasons = (e as PromotionBlockedError).reasons;
      expect(reasons.some((r) => r.startsWith('time-floor'))).toBe(true);
      expect(reasons.some((r) => r.startsWith('insufficient-applied-count'))).toBe(true);
      expect(reasons).toContain('missing-external-signal-sources');
    }
  });

  it('promoteLesson SUCCEEDS once every gate is satisfied; file moves to promoted/', async () => {
    const id = await makeLesson();
    // satisfy: age >= 24h, applied >= 3, external signal present (no thumbs-down).
    clock = '2026-06-10T00:00:00.000Z'; // > 24h after create
    await store.recordApplied(id, 's1');
    await store.recordApplied(id, 's2');
    await store.recordApplied(id, 's3');
    await store.captureFeedback(id, 'up', 'user_thumbs_up');

    const out = await store.promoteLesson(id);
    expect(out.status).toBe('promoted');
    // moved: pending file gone, promoted file present
    await expect(readFile(join(dir, 'lessons', 'pending', `${id}.md`), 'utf8')).rejects.toThrow();
    const promoted = await readFile(join(dir, 'lessons', 'promoted', `${id}.md`), 'utf8');
    expect(promoted).toContain('status: promoted');
  });

  it('a thumbs-down hard-blocks promotion even with everything else satisfied', async () => {
    const id = await makeLesson();
    clock = '2026-06-10T00:00:00.000Z';
    await store.recordApplied(id, 's1');
    await store.recordApplied(id, 's2');
    await store.recordApplied(id, 's3');
    await store.captureFeedback(id, 'up', 'user_thumbs_up');
    await store.captureFeedback(id, 'down', 'user_thumbs_down');
    await expect(store.promoteLesson(id)).rejects.toThrow(/thumbs-down-block/);
  });

  it('captureFeedback is idempotent on the signal set; recordApplied bumps applied_count', async () => {
    const id = await makeLesson();
    await store.captureFeedback(id, 'up', 'sig-x');
    await store.captureFeedback(id, 'up', 'sig-x'); // same signal again
    await store.recordApplied(id, 's1');
    await store.recordApplied(id, 's1'); // same session again
    const hits = await store.recallLesson('pnpm');
    const hit = hits.results.find((h) => h.id === id);
    expect(hit?.applied_count).toBe(2); // count bumps each call
    // signal set deduped: re-read via a fresh promote attempt's reasons (no missing-external-signal)
    clock = '2026-06-10T00:00:00.000Z';
    await store.recordApplied(id, 's2');
    await store.recordApplied(id, 's3'); // now applied >= 3 (was 2)
    const out = await store.promoteLesson(id); // age ok, applied ok, signal present (sig-x), no down
    expect(out.status).toBe('promoted');
  });

  it('recallLesson returns the engine shape (kind + similarity + applied_count)', async () => {
    await makeLesson();
    const r = await store.recallLesson('pnpm');
    expect(r.returned).toBeGreaterThan(0);
    const hit = r.results[0]!;
    expect(hit.kind).toBe('lesson');
    expect(typeof hit.similarity).toBe('number');
    expect(typeof hit.applied_count).toBe('number');
    expect(hit.description).toContain('pnpm');
  });

  it('does NOT create or touch a memory `lessons` table (separate store)', async () => {
    await makeLesson();
    const c = (await import('@libsql/client')).createClient({ url: `file:${join(dir, 'wg.db')}` });
    const tables = await c.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='lessons'`,
    );
    expect(tables.rows.length).toBe(0); // only wg_lessons exists, never `lessons`
  });
});

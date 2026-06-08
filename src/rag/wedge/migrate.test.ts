/**
 * Tests for the wedge lesson migration (retire-Rust RES-3d). Seeds on-disk `<status>/les-*.md` in
 * the engine frontmatter shape, runs migrateWedgeLessons, and asserts the wg_lessons index is built
 * (count, recall, status fidelity, idempotency).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateWedgeLessons } from './migrate.js';
import { wedgeLessonStore } from './store.js';

let dir: string;
let sourceDir: string;
let dbUrl: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wedge-migrate-'));
  sourceDir = join(dir, 'lessons');
  dbUrl = `file:${join(dir, 'wg.db')}`;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(status: string, id: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(join(sourceDir, status), { recursive: true });
  await writeFile(join(sourceDir, status, `${id}.md`), `---\n${frontmatter}---\n${body}`, 'utf8');
}

describe('migrateWedgeLessons', () => {
  beforeEach(async () => {
    // A promoted lesson in the minimal engine frontmatter shape (no updated_at/applied_session_ids).
    await seed(
      'promoted',
      'les-aaa',
      [
        'id: les-aaa',
        'description: never rebase shared branches',
        'status: promoted',
        'created_at: 2026-05-15T00:00:00.000Z',
        'applied_count: 7',
        'thumbs_up_count: 2',
        'thumbs_down_count: 0',
        'external_signal_sources: []',
        'authored_by: pack',
      ].join('\n') + '\n',
      '# Rebase rule\nNever rebase a shared branch.',
    );
    // A pending lesson with a nested causal_narrative (richer than the typed shape — must survive).
    await seed(
      'pending',
      'les-bbb',
      [
        'id: les-bbb',
        'description: prefer pnpm over npm',
        'status: pending',
        'created_at: 2026-05-16T00:00:00.000Z',
        'causal_narrative:',
        '  confidence: inferred',
        '  evidence_refs:',
        '    - quote: user said pnpm',
        'applied_count: 0',
        'thumbs_up_count: 0',
        'thumbs_down_count: 0',
        'external_signal_sources: []',
        'authored_by: agent',
      ].join('\n') + '\n',
      '# pnpm\nUse pnpm.',
    );
  });

  it('indexes every on-disk lesson and reports the count', async () => {
    const { migrated } = await migrateWedgeLessons({ dbUrl, sourceDir });
    expect(migrated).toBe(2);
  });

  it('recall finds a migrated lesson with the right status', async () => {
    await migrateWedgeLessons({ dbUrl, sourceDir });
    const store = wedgeLessonStore({ dbUrl, sourceDir });
    await store.init();
    const hits = await store.recallLesson('rebase');
    const hit = hits.results.find((h) => h.id === 'les-aaa');
    expect(hit).toBeDefined();
    expect(hit?.status).toBe('promoted');
    expect(hit?.applied_count).toBe(7);
  });

  it('is idempotent — re-running yields the same count, no duplicates', async () => {
    await migrateWedgeLessons({ dbUrl, sourceDir });
    const { migrated } = await migrateWedgeLessons({ dbUrl, sourceDir });
    expect(migrated).toBe(2);
    const store = wedgeLessonStore({ dbUrl, sourceDir });
    await store.init();
    const hits = await store.recallLesson('pnpm');
    expect(hits.results.filter((h) => h.id === 'les-bbb')).toHaveLength(1);
  });
});

/**
 * Wedge lesson migration (retire-Rust RES-3d). The on-disk engine lessons at
 * `~/.opensquid/lessons/<status>/les-*.md` ARE the wedge per-file source (RES-3b layout), so this is
 * a pure DB-index rebuild — read every record back via `readWedgeRecords` and repopulate the
 * `wg_lessons` libSQL index (no file copy/rewrite). Idempotent: `store.rebuild` DELETEs all then
 * re-inserts, so re-running yields the same count with no duplicates. Mirrors the memory-store
 * `migrateMemories` precedent.
 *
 * Imports from: ./store.js, ./source.js.
 * Imported by: src/cli.ts (the `migrate-lessons` command).
 */
import { readWedgeRecords } from './source.js';
import { wedgeLessonStore } from './store.js';

export async function migrateWedgeLessons(opts: {
  dbUrl: string;
  sourceDir: string;
}): Promise<{ migrated: number }> {
  const store = wedgeLessonStore({ dbUrl: opts.dbUrl, sourceDir: opts.sourceDir });
  await store.init();
  const records = await readWedgeRecords(opts.sourceDir);
  const { indexed } = await store.rebuild(records);
  return { migrated: indexed };
}

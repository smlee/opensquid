/**
 * LP.1 — Helpers for the per-pack personal_revision state directory at
 * `~/.opensquid/packs/<pack-id>/personal_revision/`.
 *
 * Layout:
 *   version.json                — { base_version, personal_revision_id, last_merged_vanilla }
 *   lesson_<n>.yaml             — one promoted lesson per file (n monotonic from 1)
 *   lesson_<n>.conflict.yaml    — sidecar emitted by LP.2 merger on overlap
 *
 * Atomicity invariant: every write goes via `<file>.tmp.<pid>` + `fs.rename`
 * so a crash mid-write leaves the prior version intact.
 *
 * Per [[feedback_stop_haiku_drift]] L4 / no-LLM-in-hot-path: pure I/O + YAML
 * parse; no model calls.
 *
 * Concurrency: `appendLessonFile` is NOT cross-process safe in v1. wedge/
 * promote.ts runs single-threaded per promotion; the helper inherits that
 * assumption. If multi-process promotion ever lands, wrap with
 * proper-lockfile.
 *
 * Imports: node:fs/promises, node:path, yaml. Imported by: src/packs/loader.ts
 * (LP.1 fold) + src/wedge/promote.ts (LP.3 lesson-append) + tests.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { PersonalRevision, type BaseVersion } from './schemas/manifest.js';

export interface LessonFile {
  /** Monotonic ordering id from filename `lesson_<n>.yaml`. */
  id: number;
  /** Absolute file path (so callers can copy / read / delete). */
  path: string;
  /** Parsed YAML body. */
  body: Record<string, unknown>;
  /** True iff file is a `.conflict.yaml` sidecar (unresolved merge state). */
  hasConflict: boolean;
}

const VERSION_FILE = 'version.json';
const REVISION_DIR = 'personal_revision';
const LESSON_RE = /^lesson_(\d+)(\.conflict)?\.yaml$/;

/**
 * Read version.json from a pack's personal_revision directory. Returns null
 * if directory or file is absent (e.g. fresh install, no lessons yet, OR
 * built-in pack that has no personal_revision dir). Throws on malformed
 * JSON or schema-invalid content (loud failure — the file is
 * engine-written, never user-edited).
 */
export async function readVersionJson(packStateDir: string): Promise<PersonalRevision | null> {
  const path = join(packStateDir, REVISION_DIR, VERSION_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  return PersonalRevision.parse(parsed);
}

/**
 * Write version.json atomically (temp + rename). Creates the
 * personal_revision/ directory if absent. Uses `<pid>.<rand>` suffix so
 * concurrent tests (which run in the same process under vitest pool) don't
 * collide on temp names.
 */
export async function writeVersionJson(
  packStateDir: string,
  state: PersonalRevision,
): Promise<void> {
  const dir = join(packStateDir, REVISION_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, VERSION_FILE);
  const tmp = `${path}.tmp.${String(process.pid)}.${randSuffix()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, path);
}

/**
 * Enumerate all lesson_*.yaml + lesson_*.conflict.yaml files in monotonic
 * order. Returns empty array if directory is absent. Skips malformed-name
 * files (anything not matching `^lesson_\d+(\.conflict)?\.yaml$`).
 */
export async function readLessonFiles(packStateDir: string): Promise<LessonFile[]> {
  const dir = join(packStateDir, REVISION_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const matched: LessonFile[] = [];
  for (const entry of entries) {
    const m = LESSON_RE.exec(entry);
    if (m === null) continue;
    const id = Number.parseInt(m[1]!, 10);
    const hasConflict = m[2] === '.conflict';
    const path = join(dir, entry);
    const raw = await readFile(path, 'utf8');
    const body = parseYaml(raw) as Record<string, unknown>;
    matched.push({ id, path, body, hasConflict });
  }
  matched.sort((a, b) => a.id - b.id);
  return matched;
}

/**
 * Append a new lesson_<n+1>.yaml atomically. Reads version.json, computes
 * next id, writes the lesson file (temp + rename), bumps
 * personal_revision_id in version.json. Returns the new id.
 *
 * NOT concurrency-safe across processes — caller must serialize.
 */
export async function appendLessonFile(
  packStateDir: string,
  lessonBody: Record<string, unknown>,
): Promise<number> {
  const current = await readVersionJson(packStateDir);
  if (current === null) {
    throw new Error(
      `appendLessonFile: version.json missing at ${packStateDir} — install pack first`,
    );
  }
  const nextId = current.personal_revision_id + 1;
  const dir = join(packStateDir, REVISION_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `lesson_${String(nextId)}.yaml`);
  const tmp = `${path}.tmp.${String(process.pid)}.${randSuffix()}`;
  await writeFile(tmp, stringifyYaml(lessonBody), 'utf8');
  await rename(tmp, path);
  await writeVersionJson(packStateDir, {
    ...current,
    personal_revision_id: nextId,
  });
  return nextId;
}

/**
 * Initialize a fresh personal_revision/ directory for a newly installed pack.
 * Writes version.json with personal_revision_id=0 + supplied base_version.
 * Idempotent: re-running for an already-initialized pack returns existing
 * state without overwriting.
 */
export async function initPersonalRevision(
  packStateDir: string,
  baseVersion: BaseVersion,
): Promise<PersonalRevision> {
  const existing = await readVersionJson(packStateDir);
  if (existing !== null) return existing;
  const state: PersonalRevision = {
    base_version: baseVersion,
    personal_revision_id: 0,
    last_merged_vanilla: null,
  };
  await writeVersionJson(packStateDir, state);
  return state;
}

/** Random hex suffix for temp file naming (collision avoidance in tests). */
function randSuffix(): string {
  // 8 hex chars from process.hrtime.bigint() last 32 bits — deterministic in
  // tests via fake-timers but unique across rapid sequential writes.
  const t = process.hrtime.bigint();
  return (t & 0xffffffffn).toString(16).padStart(8, '0');
}

/**
 * LP.3 — high-level "a Stage-2-promoted lesson lands in this pack's
 * personal_revision/ directory" helper. Ensures version.json exists
 * (idempotent init at `'0.0.0'` default — caller should pass a real
 * baseline via `initPersonalRevision` first when known), then appends the
 * lesson as `lesson_<n+1>.yaml` + bumps `personal_revision_id`.
 *
 * Lesson body shape per LP.3 spec:
 *   promoted_at: ISO-8601 timestamp
 *   engine_lesson_id: string (the engine's lesson id for reconciliation)
 *   lesson_body: any (engine's lesson content)
 *   cited_memory_ids: string[]
 *   skill: string (originating skill name, optional)
 *   retired: boolean (default false; user can flip via CLI later)
 *
 * Returns the new revision id. Throws on personal_revision write failure
 * — caller must surface (NO silent swallow per [[feedback_no_silent_fail_open]]).
 *
 * Imported by: store_lesson primitive (LP.3 wiring follow-up); CLI install
 * path (LP.4).
 */
export interface PromotedLessonInput {
  /** Engine-side lesson id for reconciliation. */
  engine_lesson_id: string;
  /** Engine-side lesson body. */
  lesson_body: unknown;
  /** Memory ids cited by the lesson. */
  cited_memory_ids?: string[];
  /** Originating skill name (optional — engine-direct lessons omit). */
  skill?: string;
  /** Pack base version (passed at install time; defensive '0.0.0' default). */
  packBaseVersion?: BaseVersion;
}

export async function persistPromotedLesson(
  packStateDir: string,
  lesson: PromotedLessonInput,
): Promise<number> {
  await initPersonalRevision(packStateDir, lesson.packBaseVersion ?? '0.0.0');
  return appendLessonFile(packStateDir, {
    promoted_at: new Date().toISOString(),
    engine_lesson_id: lesson.engine_lesson_id,
    lesson_body: lesson.lesson_body,
    cited_memory_ids: lesson.cited_memory_ids ?? [],
    ...(lesson.skill !== undefined ? { skill: lesson.skill } : {}),
    retired: false,
  });
}

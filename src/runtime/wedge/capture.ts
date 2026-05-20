/**
 * Stage 1 capture gate — writes pending lessons to the session-scoped buffer
 * on disk for later user validation (per the context-clearing cycle).
 *
 * Authoritative source: `docs/opensquid-real-design.md` §"Two-stage wedge gate"
 * Stage 1 + §"Automation buffer pattern" §"Directory layout" + §"Context-
 * clearing cycle".
 *
 * Layout produced:
 *
 *   ~/.opensquid/sessions/<session-id>/pending-lessons/potential-lessons/
 *     <ts>_<type>_<id>.md
 *
 * Filename ordering: `<ISO-timestamp-with-colons-replaced>_<type>_<id>.md`.
 * Colons in ISO timestamps break Windows paths, so they collapse to `-`
 * (per spec risk callout 1). The deterministic ordering lets `walkBuffer`
 * (Task 7.2) iterate by chronological proposal order without sorting on
 * parsed frontmatter.
 *
 * Frontmatter is a strict subset of YAML — no nested keys, no multiline
 * values. The `sourceContext` and `content` fields are written into the
 * Markdown body (under headings) NOT the frontmatter — that sidesteps the
 * "body contains `---`" risk callout (a stray `---` in the lesson text
 * cannot break a frontmatter parser that doesn't try to match the body).
 *
 * Validation interface: this module exposes `validatePendingLesson(lesson)`
 * — callers MUST run it before calling `capturePendingLesson`. The function
 * surface is intentionally split (rather than auto-validating in capture) so
 * the caller can choose what to do with invalid input (drop silently, route
 * to the user, raise) without the file-writer making policy decisions.
 *
 * Imports from: node:fs/promises, node:path, ../paths, ./types.
 * Imported by: src/runtime/wedge/index.ts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';

import type { LessonType, PendingLesson } from './types.js';

// ---------------------------------------------------------------------------
// pendingLessonsDir — single source of truth for the directory layout.
//
// Exported so Task 7.2's `automation_buffer.ts` can join siblings (e.g.
// `keep-as-context/`) onto the same parent without duplicating the prefix.
// ---------------------------------------------------------------------------

export function pendingLessonsDir(sessionId: string): string {
  return join(OPENSQUID_HOME(), 'sessions', sessionId, 'pending-lessons');
}

// ---------------------------------------------------------------------------
// validatePendingLesson — pure predicate, returns null on OK, error message
// otherwise. Caller decides what to do with the message.
//
// Rules:
//   - `id` non-empty (filename component).
//   - `type` is one of the three known values (TS already narrows, but
//     runtime input may be loose).
//   - `confidence` in [0, 1] (callers that store outside this range will
//     produce non-comparable buffers).
//   - `proposedAt` is a parseable ISO 8601 timestamp.
// ---------------------------------------------------------------------------

const LESSON_TYPES: ReadonlySet<LessonType> = new Set<LessonType>([
  'workflow',
  'preference',
  'skill_upgrade',
]);

export function validatePendingLesson(lesson: PendingLesson): string | null {
  if (!lesson.id || lesson.id.length === 0) return 'lesson.id must be non-empty';
  if (!LESSON_TYPES.has(lesson.type)) return `lesson.type unknown: ${String(lesson.type)}`;
  if (
    typeof lesson.confidence !== 'number' ||
    !Number.isFinite(lesson.confidence) ||
    lesson.confidence < 0 ||
    lesson.confidence > 1
  ) {
    return 'lesson.confidence must be a finite number in [0, 1]';
  }
  // Date.parse is intentionally lax; we accept anything node can read back.
  if (Number.isNaN(Date.parse(lesson.proposedAt))) {
    return `lesson.proposedAt is not parseable as a date: ${lesson.proposedAt}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// safeTimestamp — ISO timestamp with `:` → `-` (Windows-safe filename
// component). Public so Task 7.2 can reuse the same conversion for buffer
// filenames + BUFFER.md index entries.
// ---------------------------------------------------------------------------

export function safeTimestamp(iso: string): string {
  return iso.replaceAll(':', '-');
}

// ---------------------------------------------------------------------------
// capturePendingLesson — writes the lesson to potential-lessons/.
//
// Throws on validation failure (callers that want silent-drop behavior
// should run `validatePendingLesson` first and skip). The throw is what
// satisfies the "no silent acceptance" acceptance criterion: a malformed
// lesson hitting this function fails loudly, not silently.
// ---------------------------------------------------------------------------

export async function capturePendingLesson(
  sessionId: string,
  lesson: PendingLesson,
): Promise<string> {
  const err = validatePendingLesson(lesson);
  if (err) throw new Error(`invalid PendingLesson: ${err}`);

  const dir = join(pendingLessonsDir(sessionId), 'potential-lessons');
  await mkdir(dir, { recursive: true });

  const path = join(dir, `${safeTimestamp(lesson.proposedAt)}_${lesson.type}_${lesson.id}.md`);

  const author = lesson.author ?? 'agent';
  const fileBody = [
    '---',
    `id: ${lesson.id}`,
    `type: ${lesson.type}`,
    `confidence: ${lesson.confidence}`,
    `proposedAt: ${lesson.proposedAt}`,
    `author: ${author}`,
    '---',
    '',
    '## Source context',
    '',
    lesson.sourceContext,
    '',
    '## Lesson',
    '',
    lesson.content,
    '',
  ].join('\n');

  await writeFile(path, fileBody, 'utf8');
  return path;
}

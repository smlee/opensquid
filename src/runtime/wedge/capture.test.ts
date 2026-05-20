/**
 * Tests for `capturePendingLesson` (Task 7.1).
 *
 * Acceptance per phase-7-wedge-gate.md §"Task 7.1":
 *  - Capture writes to pending-lessons/potential-lessons/ per design layout.
 *  - Filename includes timestamp + type + id (deterministic ordering).
 *  - All 3 lesson types accepted (workflow / preference / skill_upgrade).
 *  - No silent acceptance (validation interface exists).
 *  - ≥ 3 tests.
 *
 * Strategy: per-test `OPENSQUID_HOME` temp dir; capture lessons; assert
 * filesystem layout + filename ordering + validation behavior.
 */

import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  capturePendingLesson,
  pendingLessonsDir,
  safeTimestamp,
  validatePendingLesson,
} from './capture.js';
import type { PendingLesson } from './types.js';

let tempHome: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = join(tmpdir(), `opensquid-capture-${Math.random().toString(36).slice(2, 10)}`);
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

function makeLesson(overrides: Partial<PendingLesson> = {}): PendingLesson {
  return {
    id: 'lesson-1',
    type: 'workflow',
    content: 'Always run lint before committing.',
    sourceContext: 'agent skipped lint on three consecutive turns',
    confidence: 0.9,
    proposedAt: '2026-05-19T10:00:00.000Z',
    ...overrides,
  };
}

describe('capturePendingLesson', () => {
  it('writes three lessons of three types into potential-lessons/', async () => {
    const sessionId = 'sess-1';
    const lessons: PendingLesson[] = [
      makeLesson({ id: 'l-w', type: 'workflow', proposedAt: '2026-05-19T10:00:00.000Z' }),
      makeLesson({ id: 'l-p', type: 'preference', proposedAt: '2026-05-19T10:00:01.000Z' }),
      makeLesson({ id: 'l-s', type: 'skill_upgrade', proposedAt: '2026-05-19T10:00:02.000Z' }),
    ];

    for (const lesson of lessons) {
      await capturePendingLesson(sessionId, lesson);
    }

    const dir = join(pendingLessonsDir(sessionId), 'potential-lessons');
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(3);

    // Filename ordering: timestamp ascending. With our safeTimestamp transform,
    // the lexicographic sort matches chronological order.
    expect(files[0]).toMatch(/^2026-05-19T10-00-00\.000Z_workflow_l-w\.md$/);
    expect(files[1]).toMatch(/^2026-05-19T10-00-01\.000Z_preference_l-p\.md$/);
    expect(files[2]).toMatch(/^2026-05-19T10-00-02\.000Z_skill_upgrade_l-s\.md$/);

    // No colons in any filename (Windows safety).
    for (const f of files) expect(f).not.toContain(':');
  });

  it('writes frontmatter + body sections with author defaulted to agent', async () => {
    const sessionId = 'sess-2';
    const path = await capturePendingLesson(
      sessionId,
      makeLesson({ id: 'l-1', content: 'Use pnpm everywhere.' }),
    );
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('---\nid: l-1');
    expect(raw).toContain('type: workflow');
    expect(raw).toContain('author: agent');
    expect(raw).toContain('## Source context');
    expect(raw).toContain('## Lesson');
    expect(raw).toContain('Use pnpm everywhere.');
  });

  it('preserves explicit user authorship', async () => {
    const sessionId = 'sess-3';
    const path = await capturePendingLesson(sessionId, makeLesson({ id: 'l-u', author: 'user' }));
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('author: user');
  });

  it('rejects invalid lessons (no silent acceptance)', async () => {
    const sessionId = 'sess-4';
    await expect(capturePendingLesson(sessionId, makeLesson({ id: '' }))).rejects.toThrow(
      /invalid PendingLesson/,
    );

    await expect(capturePendingLesson(sessionId, makeLesson({ confidence: 1.5 }))).rejects.toThrow(
      /confidence/,
    );

    await expect(
      capturePendingLesson(sessionId, makeLesson({ proposedAt: 'not-a-date' })),
    ).rejects.toThrow(/proposedAt/);
  });

  it('validatePendingLesson is a pure predicate (callable without writing)', () => {
    expect(validatePendingLesson(makeLesson())).toBeNull();
    expect(validatePendingLesson(makeLesson({ id: '' }))).toMatch(/id/);
    expect(validatePendingLesson(makeLesson({ confidence: -0.1 }))).toMatch(/confidence/);
    // Treat type as unknown — runtime might receive untyped input.
    expect(
      validatePendingLesson(makeLesson({ type: 'bogus' as unknown as PendingLesson['type'] })),
    ).toMatch(/type/);
  });

  it('safeTimestamp replaces all colons (Windows-safe filename)', () => {
    expect(safeTimestamp('2026-05-19T10:00:00Z')).toBe('2026-05-19T10-00-00Z');
    expect(safeTimestamp('no-colons-here')).toBe('no-colons-here');
  });
});

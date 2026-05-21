/**
 * agent_bridge tools — store_lesson unit tests (WAB.6, 0.5.100).
 *
 * Coverage:
 *   - spec declares required fields
 *   - validator rejects empty content + missing type
 *   - validator rejects unknown type
 *   - handler appends a JSONL row at the expected path
 *   - handler creates the directory tree on first call
 *   - handler echoes capture metadata (sessionKey + projectUuid + type)
 *   - handler honors the injected clock for capturedAt
 *
 * Filesystem isolation: every test points `OPENSQUID_HOME` at an `mkdtemp`
 * directory and restores the original env afterwards. Same pattern used by
 * the wedge-gate `capture.test.ts`.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bufferPath, makeStoreLessonHandler, storeLessonSpec } from './store_lesson.js';
import type { ToolContext } from '../types.js';

const CTX: ToolContext = {
  sessionKey: { platform: 'telegram', chatId: '8075471258', threadId: '99' },
  projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
};

describe('store_lesson.spec', () => {
  it('declares content + type as required and enums type', () => {
    expect(storeLessonSpec.name).toBe('store_lesson');
    expect(storeLessonSpec.input_schema).toMatchObject({
      required: ['content', 'type'],
      additionalProperties: false,
    });
  });

  it('validator rejects empty content', () => {
    expect(() => storeLessonSpec.validate?.({ content: '', type: 'workflow' })).toThrow();
  });

  it('validator rejects missing type', () => {
    expect(() => storeLessonSpec.validate?.({ content: 'hi' })).toThrow();
  });

  it('validator rejects unknown type', () => {
    expect(() => storeLessonSpec.validate?.({ content: 'hi', type: 'schedule_outcome' })).toThrow();
  });
});

describe('makeStoreLessonHandler', () => {
  let home: string;
  const originalHome = process.env.OPENSQUID_HOME;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'opensquid-store-lesson-'));
    process.env.OPENSQUID_HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it('appends a JSONL row with the expected fields at the buffered path', async () => {
    const handler = makeStoreLessonHandler({ nowIso: () => '2026-05-21T10:00:00.000Z' });
    const validated = storeLessonSpec.validate!({
      content: 'use pnpm not npm',
      type: 'preference',
      tags: ['tooling'],
      confidence: 0.8,
    });
    const result = await handler(validated, CTX);
    expect(result).toMatch(/captured preference lesson/);

    const raw = await readFile(bufferPath(), 'utf8');
    const rows = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      capturedAt: '2026-05-21T10:00:00.000Z',
      type: 'preference',
      content: 'use pnpm not npm',
      tags: ['tooling'],
      confidence: 0.8,
      projectUuid: CTX.projectUuid,
      sessionKey: { platform: 'telegram', chatId: '8075471258', threadId: '99' },
    });
  });

  it('creates the buffer directory tree on first append', async () => {
    const handler = makeStoreLessonHandler();
    const validated = storeLessonSpec.validate!({
      content: 'run lint before commit',
      type: 'workflow',
    });
    await handler(validated, CTX);
    // bufferPath() under the test home should now exist + be readable.
    const raw = await readFile(bufferPath(), 'utf8');
    expect(raw).toContain('"type":"workflow"');
  });

  it('honors defaulted tags + confidence', async () => {
    const handler = makeStoreLessonHandler();
    const validated = storeLessonSpec.validate!({
      content: 'tighten matcher',
      type: 'skill_upgrade',
    });
    await handler(validated, CTX);
    const raw = await readFile(bufferPath(), 'utf8');
    const row = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(row.tags).toEqual([]);
    expect(row.confidence).toBe(0.5);
  });
});

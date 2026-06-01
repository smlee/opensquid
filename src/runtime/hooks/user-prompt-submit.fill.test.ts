/**
 * Tests for the UserPromptSubmit hook's `priorAssistantText` fill (RJ.1).
 *
 * The hook bin's `main()` composes `extractTranscriptPath(raw)` +
 * `readLastAssistantText(path)` to recover the SETTLED prior assistant turn at
 * UserPromptSubmit (where it has NO off-by-one — the prior turn is flushed).
 * `extractTranscriptPath` is unit-tested directly here; the composition is
 * exercised against an on-disk fixture transcript (mirroring transcript.test.ts)
 * so the end-to-end fill is proven without spawning the compiled bin.
 *
 * Fail-open contract: a payload with no transcript path → null → the bin leaves
 * `priorAssistantText` undefined and the prompt rides through (exit 0).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLastAssistantText } from './transcript.js';
import { readOpenTasksFromTranscript } from './transcript_tasks.js';
import { extractTranscriptPath } from './user-prompt-submit.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-ups-fill-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeTranscript(lines: unknown[]): Promise<string> {
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  return path;
}

const asst = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const user = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

describe('extractTranscriptPath', () => {
  it('reads snake_case transcript_path', () => {
    const raw = JSON.stringify({ prompt: 'hi', transcript_path: '/tmp/t.jsonl' });
    expect(extractTranscriptPath(raw)).toBe('/tmp/t.jsonl');
  });

  it('reads camelCase transcriptPath', () => {
    const raw = JSON.stringify({ prompt: 'hi', transcriptPath: '/tmp/t.jsonl' });
    expect(extractTranscriptPath(raw)).toBe('/tmp/t.jsonl');
  });

  it('returns null when no transcript path is present (fail-open)', () => {
    expect(extractTranscriptPath(JSON.stringify({ prompt: 'hi' }))).toBeNull();
  });

  it('returns null on an empty-string path', () => {
    expect(extractTranscriptPath(JSON.stringify({ prompt: 'hi', transcript_path: '' }))).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(extractTranscriptPath('{not json')).toBeNull();
  });
});

describe('UPS priorAssistantText fill (composition)', () => {
  it('recovers the settled prior assistant turn from the transcript', async () => {
    // A completed turn: user prompt → assistant reply. At the NEXT UPS the
    // assistant reply is the last text-bearing entry → recovered verbatim.
    const path = await writeTranscript([
      user('do the fix'),
      asst('I just committed the fix and pushed it'),
    ]);
    const raw = JSON.stringify({ prompt: 'now verify CI', transcript_path: path });

    const tp = extractTranscriptPath(raw);
    expect(tp).toBe(path);
    const prior = await readLastAssistantText(tp!);
    expect(prior).toBe('I just committed the fix and pushed it');
  });

  it('yields "" (fail-open) when the transcript file is absent', async () => {
    const raw = JSON.stringify({ prompt: 'x', transcript_path: join(dir, 'missing.jsonl') });
    const prior = await readLastAssistantText(extractTranscriptPath(raw)!);
    expect(prior).toBe('');
  });
});

describe('UPS openTasks fill (ATM.2 composition)', () => {
  const taskCreate = (tuid: string, subject: string, metadata?: Record<string, unknown>) => ({
    message: {
      content: [
        {
          type: 'tool_use',
          id: tuid,
          name: 'TaskCreate',
          input: { subject, ...(metadata ? { metadata } : {}) },
        },
      ],
    },
  });
  const taskCreateResult = (tuid: string, id: string) => ({
    message: {
      content: [
        { type: 'tool_result', tool_use_id: tuid, content: `Task #${id} created successfully` },
      ],
    },
  });
  const taskUpdate = (taskId: string, status: string) => ({
    message: {
      content: [
        { type: 'tool_use', id: `u-${taskId}`, name: 'TaskUpdate', input: { taskId, status } },
      ],
    },
  });

  it('derives the open-task list (with provenance) the hook puts on the event', async () => {
    const path = await writeTranscript([
      taskCreate('t1', 'A', { taskId: 'ATM.1' }),
      taskCreateResult('t1', '16'),
      taskUpdate('16', 'in_progress'),
      taskCreate('t2', 'smuggled'), // no metadata
      taskCreateResult('t2', '18'),
      taskUpdate('18', 'pending'),
    ]);
    const raw = JSON.stringify({ prompt: 'go', transcript_path: path });
    const open = await readOpenTasksFromTranscript(extractTranscriptPath(raw)!);
    expect(open).toEqual([
      { id: '16', status: 'in_progress', taskId: 'ATM.1' },
      { id: '18', status: 'pending' },
    ]);
  });

  it('yields [] (fail-open) when the transcript file is absent', async () => {
    const raw = JSON.stringify({ prompt: 'x', transcript_path: join(dir, 'missing.jsonl') });
    expect(await readOpenTasksFromTranscript(extractTranscriptPath(raw)!)).toEqual([]);
  });
});

/**
 * Tests for transcript-derived active task (T-ATM ATM.1) + open-task list (ATM.2).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readActiveTaskFromTranscript,
  readAllTasksFromTranscript,
  readOpenTasksFromTranscript,
} from './transcript_tasks.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opensquid-txtasks-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Transcript entry helpers (mirror the verified CC jsonl shape).
const create = (tuid: string, subject: string, metadata?: Record<string, unknown>) => ({
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
const createResult = (tuid: string, id: string, subject: string) => ({
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: tuid,
        content: `Task #${id} created successfully: ${subject}`,
      },
    ],
  },
});
const update = (taskId: string, status: string, metadata?: Record<string, unknown>) => ({
  message: {
    content: [
      {
        type: 'tool_use',
        id: `u-${taskId}-${status}`,
        name: 'TaskUpdate',
        input: { taskId, status, ...(metadata ? { metadata } : {}) },
      },
    ],
  },
});
// T-FIX-TASKSTART-GUARD-MIRROR: a metadata-only TaskUpdate (no status field).
const updateMeta = (taskId: string, metadata: Record<string, unknown>) => ({
  message: {
    content: [
      {
        type: 'tool_use',
        id: `um-${taskId}`,
        name: 'TaskUpdate',
        input: { taskId, metadata },
      },
    ],
  },
});

async function tx(lines: unknown[]): Promise<string> {
  const p = join(dir, 'transcript.jsonl');
  await writeFile(p, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  return p;
}

describe('readActiveTaskFromTranscript', () => {
  it('resolves the in_progress task with subject + metadata (id from the result)', async () => {
    const p = await tx([
      create('tu1', 'Task A', { taskId: 'A', spec: '/abs/a.md' }),
      createResult('tu1', '16', 'Task A'),
      update('16', 'in_progress'),
    ]);
    expect(await readActiveTaskFromTranscript(p)).toMatchObject({
      id: '16',
      subject: 'Task A',
      taskId: 'A',
      spec: '/abs/a.md',
    });
  });

  it('switches to the newer task after the old one completes', async () => {
    const p = await tx([
      create('tu1', 'A', { taskId: 'A' }),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
      update('16', 'completed'),
      create('tu2', 'B', { taskId: 'B' }),
      createResult('tu2', '17', 'B'),
      update('17', 'in_progress'),
    ]);
    expect((await readActiveTaskFromTranscript(p))?.id).toBe('17');
  });

  it('with two in_progress, the most recent wins', async () => {
    const p = await tx([
      create('tu1', 'A'),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
      create('tu2', 'B'),
      createResult('tu2', '17', 'B'),
      update('17', 'in_progress'),
    ]);
    expect((await readActiveTaskFromTranscript(p))?.id).toBe('17');
  });

  it('returns null when all tasks are completed', async () => {
    const p = await tx([
      create('tu1', 'A'),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
      update('16', 'completed'),
    ]);
    expect(await readActiveTaskFromTranscript(p)).toBeNull();
  });

  it('H4a: pending in-flight TaskUpdate(in_progress) wins even before it is in the transcript', async () => {
    const p = await tx([create('tu1', 'A', { taskId: 'A' }), createResult('tu1', '16', 'A')]);
    // No in_progress in the transcript yet; the pending overlay activates 16.
    expect(
      (await readActiveTaskFromTranscript(p, { taskId: '16', status: 'in_progress' }))?.id,
    ).toBe('16');
  });

  it('returns null for an absent transcript (fail-open)', async () => {
    expect(await readActiveTaskFromTranscript(join(dir, 'nope.jsonl'))).toBeNull();
  });

  it('skips malformed lines and still resolves', async () => {
    const p = join(dir, 't.jsonl');
    await writeFile(
      p,
      [
        '{bad json',
        JSON.stringify(create('tu1', 'A', { taskId: 'A' })),
        '',
        JSON.stringify(createResult('tu1', '16', 'A')),
        JSON.stringify(update('16', 'in_progress')),
      ].join('\n'),
      'utf8',
    );
    expect((await readActiveTaskFromTranscript(p))?.id).toBe('16');
  });

  // T-FIX-TASKSTART-GUARD-MIRROR: a metadata-only TaskUpdate (no status) is a
  // real mutation — it must reach the served metadata WITHOUT touching
  // activation. (The pre-fix walk dropped it: the mirror kept serving a stale
  // relative spec and the FU.11 guard false-reset the FSM mid-flow, twice.)
  it('metadata-only TaskUpdate in the transcript corrects the served spec', async () => {
    const p = await tx([
      create('tu1', 'A', { taskId: 'A', spec: 'loop/docs/tasks/T-a.md' }),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
      updateMeta('16', { spec: '/abs/loop/docs/tasks/T-a.md' }),
    ]);
    expect(await readActiveTaskFromTranscript(p)).toMatchObject({
      id: '16',
      spec: '/abs/loop/docs/tasks/T-a.md', // corrected, not the stale relative
    });
  });

  it('metadata-only update does NOT change activation (no status transition)', async () => {
    const p = await tx([
      create('tu1', 'A', { taskId: 'A' }),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
      update('16', 'completed'),
      updateMeta('16', { spec: '/abs/x.md' }), // after completion — must NOT reactivate
    ]);
    expect(await readActiveTaskFromTranscript(p)).toBeNull();
  });

  it('metadata-only update as the IN-FLIGHT pending overlay is honored (H4a)', async () => {
    const p = await tx([
      create('tu1', 'A', { taskId: 'A', spec: 'loop/docs/tasks/T-a.md' }),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
    ]);
    expect(
      await readActiveTaskFromTranscript(p, {
        taskId: '16',
        metadata: { spec: '/abs/loop/docs/tasks/T-a.md' },
      }),
    ).toMatchObject({ id: '16', spec: '/abs/loop/docs/tasks/T-a.md' });
  });
});

describe('readOpenTasksFromTranscript (ATM.2 — Gate B open-task list)', () => {
  it('returns open tasks with taskId provenance from metadata', async () => {
    const p = await tx([
      create('tu1', 'A', { taskId: 'ATM.1' }),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
    ]);
    expect(await readOpenTasksFromTranscript(p)).toEqual([
      { id: '16', status: 'in_progress', taskId: 'ATM.1' },
    ]);
  });

  it('a created-but-never-updated task is open + pending (seeded), provenance from create', async () => {
    const p = await tx([create('tu1', 'A', { taskId: 'ATM.1' }), createResult('tu1', '18', 'A')]);
    expect(await readOpenTasksFromTranscript(p)).toEqual([
      { id: '18', status: 'pending', taskId: 'ATM.1' },
    ]);
  });

  it('flags an open task lacking taskId (no provenance)', async () => {
    const p = await tx([
      create('tu1', 'smuggled'), // no metadata
      createResult('tu1', '18', 'smuggled'),
      update('18', 'in_progress'),
    ]);
    expect(await readOpenTasksFromTranscript(p)).toEqual([{ id: '18', status: 'in_progress' }]);
  });

  it('excludes completed/deleted tasks', async () => {
    const p = await tx([
      create('tu1', 'A', { taskId: 'ATM.1' }),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
      update('16', 'completed'),
      create('tu2', 'B', { taskId: 'ATM.2' }),
      createResult('tu2', '17', 'B'),
      update('17', 'in_progress'),
    ]);
    expect(await readOpenTasksFromTranscript(p)).toEqual([
      { id: '17', status: 'in_progress', taskId: 'ATM.2' },
    ]);
  });

  it('returns [] for an absent transcript (fail-open)', async () => {
    expect(await readOpenTasksFromTranscript(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('H4a: the in-flight pending TaskUpdate is folded into the open list', async () => {
    const p = await tx([create('tu1', 'A', { taskId: 'ATM.1' }), createResult('tu1', '16', 'A')]);
    // pending overlay moves 16 → in_progress before it is in the transcript.
    expect(await readOpenTasksFromTranscript(p, { taskId: '16', status: 'in_progress' })).toEqual([
      { id: '16', status: 'in_progress', taskId: 'ATM.1' },
    ]);
  });
});

describe('readAllTasksFromTranscript (#26 — the full harness projection the work-graph sync consumes)', () => {
  it('carries subject + status + {taskId,spec} provenance for an open task', async () => {
    const p = await tx([
      create('tu1', 'Task A', { taskId: 'A', spec: '/abs/a.md' }),
      createResult('tu1', '16', 'Task A'),
      update('16', 'in_progress'),
    ]);
    expect(await readAllTasksFromTranscript(p)).toEqual([
      { id: '16', subject: 'Task A', status: 'in_progress', metadata: { taskId: 'A', spec: '/abs/a.md' } },
    ]);
  });

  it('INCLUDES completed/deleted tasks (unlike the open-only reader — the sync closes their issues)', async () => {
    const p = await tx([
      create('tu1', 'A', { taskId: 'A' }),
      createResult('tu1', '16', 'A'),
      update('16', 'in_progress'),
      update('16', 'completed'),
      create('tu2', 'B', { taskId: 'B' }),
      createResult('tu2', '17', 'B'),
      update('17', 'deleted'),
    ]);
    expect(await readAllTasksFromTranscript(p)).toEqual([
      { id: '16', subject: 'A', status: 'completed', metadata: { taskId: 'A' } },
      { id: '17', subject: 'B', status: 'deleted', metadata: { taskId: 'B' } },
    ]);
  });

  it('omits metadata entirely when a task carries no provenance', async () => {
    const p = await tx([
      create('tu1', 'smuggled'),
      createResult('tu1', '18', 'smuggled'),
      update('18', 'in_progress'),
    ]);
    expect(await readAllTasksFromTranscript(p)).toEqual([
      { id: '18', subject: 'smuggled', status: 'in_progress' },
    ]);
  });

  it('returns [] for an absent transcript (fail-open)', async () => {
    expect(await readAllTasksFromTranscript(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('H4a: the in-flight pending TaskUpdate is overlaid onto the full projection', async () => {
    const p = await tx([create('tu1', 'A', { taskId: 'A' }), createResult('tu1', '16', 'A')]);
    // pending overlay closes 16 before it is in the transcript — the sync must see the completion.
    expect(await readAllTasksFromTranscript(p, { taskId: '16', status: 'completed' })).toEqual([
      { id: '16', subject: 'A', status: 'completed', metadata: { taskId: 'A' } },
    ]);
  });
});

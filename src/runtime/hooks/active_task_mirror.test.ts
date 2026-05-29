/**
 * Tests for the AP.1 active-task mirror.
 *
 * Coverage:
 *   - in_progress task in the store → active-task.json written (with provenance)
 *   - only pending/completed tasks → signal cleared
 *   - H4a activation: TaskUpdate(in_progress) while disk still says 'pending'
 *   - H4a completion: TaskUpdate(completed) while disk still says 'in_progress'
 *   - non-task tool → no-op (no read, no write)
 *   - absent store dir → cleared, no throw
 *   - malformed task file → skipped, valid sibling still mirrored
 *   - real on-disk shape ({id,subject,status,metadata}) parses (d9-guard.sh trap guard)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readActiveTask, writeActiveTask } from '../session_state.js';

import { mirrorActiveTask, readHarnessTasks } from './active_task_mirror.js';

let tempHome: string; // OPENSQUID_HOME (where active-task.json is written)
let tasksBase: string; // injected harness task-store root
let priorHome: string | undefined;

const SID = 'sess-ap1';

/** Write a harness task file into the injected store dir. */
async function putTask(
  t: { id: string; subject: string; status: string; metadata?: Record<string, unknown> },
  raw?: string,
): Promise<void> {
  const dir = join(tasksBase, SID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${t.id}.json`), raw ?? JSON.stringify(t), 'utf8');
}

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-ap1-home-'));
  tasksBase = await mkdtemp(join(tmpdir(), 'opensquid-ap1-tasks-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
  await rm(tasksBase, { recursive: true, force: true });
});

describe('readHarnessTasks', () => {
  it('returns [] when the store dir is absent', async () => {
    expect(await readHarnessTasks(SID, tasksBase)).toEqual([]);
  });

  it('parses the real on-disk shape incl. metadata, skips .lock/.highwatermark', async () => {
    await putTask({
      id: '15',
      subject: 'Automate the 7-layer workflow',
      status: 'in_progress',
      metadata: { taskId: 'AP', spec: 'docs/tasks/T-automation-pipeline.md', phase: 1 },
    });
    const dir = join(tasksBase, SID);
    await writeFile(join(dir, '.lock'), '', 'utf8');
    await writeFile(join(dir, '.highwatermark'), '15', 'utf8');

    const tasks = await readHarnessTasks(SID, tasksBase);
    expect(tasks).toEqual([
      {
        id: '15',
        subject: 'Automate the 7-layer workflow',
        status: 'in_progress',
        metadata: { taskId: 'AP', spec: 'docs/tasks/T-automation-pipeline.md' },
      },
    ]);
  });

  it('skips a malformed task file but keeps valid siblings', async () => {
    await putTask({ id: '1', subject: 'good', status: 'pending' });
    await putTask({ id: '2', subject: '', status: '' }, '{ not json');
    const tasks = await readHarnessTasks(SID, tasksBase);
    expect(tasks.map((t) => t.id)).toEqual(['1']);
  });
});

describe('mirrorActiveTask', () => {
  it('writes active-task.json (with provenance) for an in_progress task', async () => {
    await putTask({
      id: '15',
      subject: 'workflow',
      status: 'in_progress',
      metadata: { taskId: 'AP', spec: 'docs/tasks/T-automation-pipeline.md' },
    });
    await mirrorActiveTask(SID, 'TaskUpdate', {}, tasksBase);

    const signal = await readActiveTask(SID);
    expect(signal?.id).toBe('15');
    expect(signal?.subject).toBe('workflow');
    expect(signal?.taskId).toBe('AP');
    expect(signal?.spec).toBe('docs/tasks/T-automation-pipeline.md');
    expect(typeof signal?.started_at).toBe('string');
  });

  it('clears the signal when no task is in_progress', async () => {
    await writeActiveTask(SID, { id: 'old', subject: 'x', started_at: 'z' });
    await putTask({ id: '1', subject: 'a', status: 'pending' });
    await putTask({ id: '2', subject: 'b', status: 'completed' });

    await mirrorActiveTask(SID, 'TaskCreate', {}, tasksBase);
    expect(await readActiveTask(SID)).toBeNull();
  });

  it('H4a activation: honors a pending TaskUpdate(in_progress) before disk catches up', async () => {
    // Disk still says 'pending' (PreToolUse fires pre-execution).
    await putTask({ id: '15', subject: 'workflow', status: 'pending' });
    await mirrorActiveTask(SID, 'TaskUpdate', { taskId: '15', status: 'in_progress' }, tasksBase);

    expect((await readActiveTask(SID))?.id).toBe('15');
  });

  it('H4a completion: excludes a task being completed even though disk still says in_progress', async () => {
    await writeActiveTask(SID, { id: '15', subject: 'workflow', started_at: 'z' });
    await putTask({ id: '15', subject: 'workflow', status: 'in_progress' });
    await mirrorActiveTask(SID, 'TaskUpdate', { taskId: '15', status: 'completed' }, tasksBase);

    expect(await readActiveTask(SID)).toBeNull();
  });

  it('H4a completion with another in_progress sibling → switches to the sibling', async () => {
    await putTask({ id: '15', subject: 'first', status: 'in_progress' });
    await putTask({ id: '16', subject: 'second', status: 'in_progress' });
    await mirrorActiveTask(SID, 'TaskUpdate', { taskId: '15', status: 'completed' }, tasksBase);

    expect((await readActiveTask(SID))?.id).toBe('16');
  });

  // T-ATSC L1: mirror re-derives on EVERY PreToolUse (no TASK_TOOLS gate).
  // The two cases below replace the previous "non-task tool = no-op" test.
  it('T-ATSC L1: non-task tool re-derives from store — clears signal when no in_progress task exists', async () => {
    await writeActiveTask(SID, { id: 'keep', subject: 'x', started_at: 'z' });
    await putTask({ id: '1', subject: 'a', status: 'pending' });
    await mirrorActiveTask(SID, 'Bash', { command: 'ls' }, tasksBase);

    // Pre-T-ATSC: signal stayed as 'keep' (mirror skipped). Post-T-ATSC: mirror
    // re-derives and finds no in_progress task → clears.
    expect(await readActiveTask(SID)).toBeNull();
  });

  it('T-ATSC L1: non-task tool re-derives from store — keeps signal aligned with on-disk in_progress task', async () => {
    await writeActiveTask(SID, { id: 'stale', subject: 'old', started_at: 'z' });
    await putTask({ id: '7', subject: 'live', status: 'in_progress' });
    await mirrorActiveTask(SID, 'Edit', { file_path: '/tmp/x.ts' }, tasksBase);

    // Mirror re-derives; signal now matches the on-disk in_progress task.
    expect((await readActiveTask(SID))?.id).toBe('7');
    expect((await readActiveTask(SID))?.subject).toBe('live');
  });

  it('absent store dir → clears the signal, never throws', async () => {
    await writeActiveTask(SID, { id: 'old', subject: 'x', started_at: 'z' });
    await expect(
      mirrorActiveTask('no-such-session', 'TaskUpdate', {}, tasksBase),
    ).resolves.toBeUndefined();
  });
});

describe('mirrorActiveTask — H4a metadata overlay (AP.7)', () => {
  it('pending args.metadata wins over a stale store (provenance set in the SAME TaskUpdate)', async () => {
    // Store has the task in_progress but WITHOUT metadata (the pre-execution lag).
    await putTask({ id: '15', subject: 'workflow', status: 'in_progress' });
    await mirrorActiveTask(
      SID,
      'TaskUpdate',
      { taskId: '15', status: 'in_progress', metadata: { taskId: 'AP', spec: '/abs/x.md' } },
      tasksBase,
    );
    const signal = await readActiveTask(SID);
    expect(signal?.taskId).toBe('AP');
    expect(signal?.spec).toBe('/abs/x.md');
  });

  it('pending args.metadata overrides a STALE store metadata value', async () => {
    await putTask({
      id: '15',
      subject: 'workflow',
      status: 'in_progress',
      metadata: { taskId: 'OLD', spec: '/abs/old.md' },
    });
    await mirrorActiveTask(
      SID,
      'TaskUpdate',
      { taskId: '15', status: 'in_progress', metadata: { taskId: 'NEW', spec: '/abs/new.md' } },
      tasksBase,
    );
    const signal = await readActiveTask(SID);
    expect(signal?.taskId).toBe('NEW');
    expect(signal?.spec).toBe('/abs/new.md');
  });

  it('falls back to store metadata when the TaskUpdate carries none (no regression)', async () => {
    await putTask({
      id: '15',
      subject: 'workflow',
      status: 'in_progress',
      metadata: { taskId: 'AP', spec: '/abs/x.md' },
    });
    await mirrorActiveTask(SID, 'TaskUpdate', { taskId: '15', status: 'in_progress' }, tasksBase);
    const signal = await readActiveTask(SID);
    expect(signal?.taskId).toBe('AP');
    expect(signal?.spec).toBe('/abs/x.md');
  });

  it('does NOT cross-apply args.metadata meant for a different task', async () => {
    // Active task is 15 (in_progress in store, with its own metadata); the
    // TaskUpdate targets a DIFFERENT task 16 → 15's signal keeps its store metadata.
    await putTask({
      id: '15',
      subject: 'workflow',
      status: 'in_progress',
      metadata: { taskId: 'AP', spec: '/abs/x.md' },
    });
    await mirrorActiveTask(
      SID,
      'TaskUpdate',
      { taskId: '16', metadata: { taskId: 'WRONG', spec: '/abs/wrong.md' } },
      tasksBase,
    );
    const signal = await readActiveTask(SID);
    expect(signal?.id).toBe('15');
    expect(signal?.taskId).toBe('AP'); // store value, NOT the cross-task args
    expect(signal?.spec).toBe('/abs/x.md');
  });
});

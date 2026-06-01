/**
 * Tests for the AP.4 workflow-gate read-side primitives.
 *
 *   - has_active_task: present:false when no signal; present:true + id/task_id
 *     (provenance) when a task is active
 *   - workflow_phases_complete: active:false when none; complete flips true only
 *     when all 7 REQUIRED phases are logged for the LIVE active task
 *   - a stale ledger (phases for a now-inactive task) → complete:false
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeActiveTask } from '../runtime/session_state.js';
import { REQUIRED_PHASES, appendPhase } from '../runtime/workflow_phases.js';

import {
  HasActiveTask,
  HasGeneratedSpec,
  TaskListGenerated,
  WorkflowPhasesComplete,
} from './active_task.js';
import type { EvalCtx } from './registry.js';

let tempHome: string;
let priorHome: string | undefined;
let priorTasksDir: string | undefined;
let tasksDir: string;
const SID = 'sess-fn';

/** Minimal EvalCtx — the primitives only read ctx.sessionId. */
function ctx(): EvalCtx {
  return {
    event: { kind: 'session_end', sessionId: SID },
    bindings: new Map(),
    sessionId: SID,
    packId: 'test',
  };
}

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  priorTasksDir = process.env.OPENSQUID_HARNESS_TASKS_DIR;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-fn-'));
  tasksDir = await mkdtemp(join(tmpdir(), 'opensquid-fn-tasks-'));
  process.env.OPENSQUID_HOME = tempHome;
  process.env.OPENSQUID_HARNESS_TASKS_DIR = tasksDir;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  if (priorTasksDir === undefined) delete process.env.OPENSQUID_HARNESS_TASKS_DIR;
  else process.env.OPENSQUID_HARNESS_TASKS_DIR = priorTasksDir;
  await rm(tempHome, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
});

/** Write a harness task file into the env-overridden store dir. */
async function putHarnessTask(t: {
  id: string;
  subject: string;
  status: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const dir = join(tasksDir, SID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${t.id}.json`), JSON.stringify(t), 'utf8');
}

describe('has_active_task', () => {
  it('present:false with empty ids when no active task', async () => {
    const r = await HasActiveTask.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { present: false, id: '', task_id: '' } });
  });

  it('present:true with id + provenance task_id when active', async () => {
    await writeActiveTask(SID, {
      id: '15',
      subject: 'workflow',
      started_at: 'z',
      taskId: 'AP',
    });
    const r = await HasActiveTask.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { present: true, id: '15', task_id: 'AP' } });
  });
});

describe('workflow_phases_complete', () => {
  it('active:false, complete:false when no active task', async () => {
    const r = await WorkflowPhasesComplete.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { active: false, complete: false } });
  });

  it('complete:false until all 7 phases logged, true after', async () => {
    await writeActiveTask(SID, { id: '15', subject: 'workflow', started_at: 'z' });
    for (const p of REQUIRED_PHASES.slice(0, 6)) await appendPhase(SID, '15', p);

    let r = await WorkflowPhasesComplete.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { active: true, complete: false } });

    await appendPhase(SID, '15', 'fix');
    r = await WorkflowPhasesComplete.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { active: true, complete: true } });
  });

  it('complete:false when the ledger is for a now-inactive task (no inheritance)', async () => {
    // All 7 logged for task 15…
    for (const p of REQUIRED_PHASES) await appendPhase(SID, '15', p);
    // …but task 16 is the active one now.
    await writeActiveTask(SID, { id: '16', subject: 'next', started_at: 'z' });

    const r = await WorkflowPhasesComplete.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { active: true, complete: false } });
  });
});

describe('has_generated_spec', () => {
  it('present:false, generated:false when no active task', async () => {
    const r = await HasGeneratedSpec.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { present: false, generated: false } });
  });

  it('generated:false when the active task carries no spec provenance', async () => {
    await writeActiveTask(SID, { id: '15', subject: 'x', started_at: 'z' });
    const r = await HasGeneratedSpec.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { present: true, generated: false } });
  });

  it('generated:true when an ABSOLUTE spec path resolves on disk (H7 cross-repo)', async () => {
    const specPath = join(tempHome, 'T-some-track.md');
    await writeFile(specPath, '### Task X.1', 'utf8');
    await writeActiveTask(SID, {
      id: '15',
      subject: 'x',
      started_at: 'z',
      taskId: 'X',
      spec: specPath,
    });
    const r = await HasGeneratedSpec.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { present: true, generated: true } });
  });

  it('generated:false when the spec path dangles (does not exist)', async () => {
    await writeActiveTask(SID, {
      id: '15',
      subject: 'x',
      started_at: 'z',
      taskId: 'X',
      spec: join(tempHome, 'no-such-spec.md'),
    });
    const r = await HasGeneratedSpec.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { present: true, generated: false } });
  });
});

describe('task_list_generated (Gate B)', () => {
  it('all_generated:true on an empty store', async () => {
    const r = await TaskListGenerated.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { all_generated: true, ungenerated: [] } });
  });

  it('all_generated:true when every open task carries metadata.taskId', async () => {
    await putHarnessTask({
      id: '1',
      subject: 'a',
      status: 'pending',
      metadata: { taskId: 'AP.1' },
    });
    await putHarnessTask({
      id: '2',
      subject: 'b',
      status: 'in_progress',
      metadata: { taskId: 'AP.2' },
    });
    const r = await TaskListGenerated.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { all_generated: true, ungenerated: [] } });
  });

  it('flags an open task with no provenance stamp (smuggled in)', async () => {
    await putHarnessTask({
      id: '1',
      subject: 'a',
      status: 'pending',
      metadata: { taskId: 'AP.1' },
    });
    await putHarnessTask({ id: '2', subject: 'smuggled', status: 'pending' }); // no metadata
    const r = await TaskListGenerated.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { all_generated: false, ungenerated: ['2'] } });
  });

  it('ignores completed/deleted tasks (only open work must be generated)', async () => {
    await putHarnessTask({ id: '1', subject: 'done', status: 'completed' }); // no metadata, but completed
    await putHarnessTask({
      id: '2',
      subject: 'ok',
      status: 'pending',
      metadata: { taskId: 'AP.2' },
    });
    const r = await TaskListGenerated.execute({}, ctx());
    expect(r).toEqual({ ok: true, value: { all_generated: true, ungenerated: [] } });
  });

  // ATM.2: when the UPS hook supplies the transcript-derived open-task list on
  // the prompt_submit event, Gate B reads it (NOT the stale ~/.claude/tasks
  // store, empty on this CC version).
  describe('reads event.openTasks (prompt_submit) over the harness store', () => {
    const promptCtx = (openTasks?: { id: string; status: string; taskId?: string }[]): EvalCtx => ({
      event: {
        kind: 'prompt_submit',
        prompt: 'go',
        ...(openTasks !== undefined ? { openTasks } : {}),
      },
      bindings: new Map(),
      sessionId: SID,
      packId: 'test',
    });

    it('all_generated:true when every open task in the event carries taskId', async () => {
      const r = await TaskListGenerated.execute(
        {},
        promptCtx([
          { id: '16', status: 'in_progress', taskId: 'ATM.1' },
          { id: '17', status: 'pending', taskId: 'ATM.2' },
        ]),
      );
      expect(r).toEqual({ ok: true, value: { all_generated: true, ungenerated: [] } });
    });

    it('flags an open event task lacking taskId provenance', async () => {
      const r = await TaskListGenerated.execute(
        {},
        promptCtx([
          { id: '16', status: 'in_progress', taskId: 'ATM.1' },
          { id: '18', status: 'pending' }, // smuggled — no taskId
        ]),
      );
      expect(r).toEqual({ ok: true, value: { all_generated: false, ungenerated: ['18'] } });
    });

    it('ignores the harness store entirely when the event field is present', async () => {
      // A smuggled task in the (stale) store must NOT be read when the event
      // carries the authoritative transcript-derived list.
      await putHarnessTask({ id: '99', subject: 'stale-smuggled', status: 'pending' });
      const r = await TaskListGenerated.execute(
        {},
        promptCtx([{ id: '16', status: 'in_progress', taskId: 'ATM.1' }]),
      );
      expect(r).toEqual({ ok: true, value: { all_generated: true, ungenerated: [] } });
    });

    it('falls back to the harness store when the event has no openTasks', async () => {
      await putHarnessTask({ id: '2', subject: 'smuggled', status: 'pending' }); // no metadata
      const r = await TaskListGenerated.execute({}, promptCtx()); // prompt_submit, openTasks undefined
      expect(r).toEqual({ ok: true, value: { all_generated: false, ungenerated: ['2'] } });
    });
  });
});

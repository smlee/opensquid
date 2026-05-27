/**
 * Tests for the AP.4 workflow-gate read-side primitives.
 *
 *   - has_active_task: present:false when no signal; present:true + id/task_id
 *     (provenance) when a task is active
 *   - workflow_phases_complete: active:false when none; complete flips true only
 *     when all 7 REQUIRED phases are logged for the LIVE active task
 *   - a stale ledger (phases for a now-inactive task) → complete:false
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeActiveTask } from '../runtime/session_state.js';
import { REQUIRED_PHASES, appendPhase } from '../runtime/workflow_phases.js';

import { HasActiveTask, WorkflowPhasesComplete } from './active_task.js';
import type { EvalCtx } from './registry.js';

let tempHome: string;
let priorHome: string | undefined;
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
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-fn-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

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

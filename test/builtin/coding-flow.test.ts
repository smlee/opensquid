/**
 * Built-in `coding-flow` pack (T-FSM-UNIFY) — the unified, FSM-driven
 * problem-solving discipline that supersedes scope-fsm + workflow-fsm. FU.1
 * covers the FSM backbone only (manifest + fsm.yaml); the guards land in FU.2.
 * This proves the on-disk union machine loads + is total, with the three
 * region-defining edges intact (guess-audit loop-back, spec-audit advance).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerEventFunctions } from '../../src/functions/event.js';
import { registerFsmFunctions } from '../../src/functions/fsm.js';
import { FunctionRegistry } from '../../src/functions/registry.js';
import { registerStateFunctions } from '../../src/functions/state.js';
import { registerVerdictFunctions } from '../../src/functions/verdict.js';
import { loadPack } from '../../src/packs/loader.js';
import { step, validateFsm } from '../../src/runtime/fsm.js';
import { readFsmState } from '../../src/runtime/fsm_state.js';
import { dispatchEvent } from '../../src/runtime/hooks/dispatch.js';
import { ok } from '../../src/runtime/result.js';
import {
  HasActiveTask,
  HasGeneratedSpec,
  WorkflowPhasesComplete,
} from '../../src/functions/active_task.js';
import { writeActiveTask } from '../../src/runtime/session_state.js';
import { appendPhase, REQUIRED_PHASES } from '../../src/runtime/workflow_phases.js';
import type { ToolCallEvent } from '../../src/runtime/types.js';

function registry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  return r;
}

const writeCode: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'src/feature.ts' },
};
const writeResearch: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/research/x-pre-research-2026-06-03.md' },
};
const writeSpec: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/tasks/T-x.md' },
};
const taskCreate: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'TaskCreate',
  args: { metadata: { taskId: 'X.1', spec: '/abs/spec.md' } },
};

describe('builtin coding-flow pack — FSM backbone (FU.1)', () => {
  it('loads with the union FSM and is total (validateFsm clean)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(pack.name).toBe('coding-flow');
    expect(pack.fsm?.initial).toBe('idle');
    expect(pack.fsm?.states).toEqual([
      'idle',
      'scoping',
      'researching',
      'researched',
      'spec_authored',
      'spec_complete',
      'tasks_loaded',
      'phases_in_flight',
      'phases_complete',
    ]);
    expect(validateFsm(pack.fsm!)).toEqual([]);
  });

  it('SCOPE: guess-audit loops researched back to researching (D3)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'guess_found')).toMatchObject({
      next: 'researching',
      transitioned: true,
    });
    expect(step(pack.fsm!, 'researching', 'research_done')).toMatchObject({
      next: 'researched',
      transitioned: true,
    });
  });

  it('AUTHOR: spec-audit advances spec_authored → spec_complete, then tasks_loaded (D7)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'spec_drafted')).toMatchObject({ next: 'spec_authored' });
    expect(step(pack.fsm!, 'spec_authored', 'spec_verified')).toMatchObject({
      next: 'spec_complete',
    });
    expect(step(pack.fsm!, 'spec_complete', 'tasks_loaded')).toMatchObject({
      next: 'tasks_loaded',
    });
  });

  it('is total: an unmatched event is an explicit stay, never a crash', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'no_such_event')).toMatchObject({
      next: 'researched',
      transitioned: false,
    });
    // spec_complete cannot be skipped: a stray research_done at spec_authored stays put
    expect(step(pack.fsm!, 'spec_authored', 'research_done')).toMatchObject({
      next: 'spec_authored',
      transitioned: false,
    });
  });
});

describe('builtin coding-flow pack — gates fire through the dispatcher (FU.2)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('SCOPE gate: blocks src/ pre-research, then allows once the pre-research doc is written', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-scope';
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(2); // idle → blocked
    expect((await dispatchEvent(writeResearch, [pack], reg, sid)).exitCode).toBe(0); // → researched
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(0); // researched → allowed
  });

  it('AUTHOR gate: TaskCreate is blocked until the spec passes audit (stays at spec_authored)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-author';
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored (no audit stub → never spec_verified)
    // The AUTHOR content gate: no tasks until spec_complete.
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2);
  });
});

/** Prompt-aware subagent_call stub: the guess-audit prompt (NEVER-GUESS) always
 *  passes GUESS_FREE so research reaches `researched`; the spec-audit prompt gets
 *  the configurable `specVerdict` — so the AUTHOR gate's determinism is under test. */
function registryWithAudit(specVerdict: string): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  r.register({
    name: 'subagent_call',
    argSchema: z.object({
      model: z.string(),
      prompt: z.string(),
      timeout_ms: z.number().optional(),
    }),
    durable: false,
    execute: (args: { prompt: string }) =>
      Promise.resolve(
        ok(args.prompt.includes('NEVER-GUESS') ? 'VERDICT: GUESS_FREE' : specVerdict),
      ),
  });
  return r;
}

const researchWithContent: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: {
    file_path: 'docs/research/x-pre-research-2026-06-03.md',
    content: '# Pre-research\n\nDerived from src/foo.ts:1.',
  },
};
const specWithContent: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/tasks/T-x.md', content: '### Task X.1\n\n(real 11-field spec)' },
};

describe('builtin coding-flow pack — the AUTHOR content gate end-to-end (spec-audit, FU.4)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-audit-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('SPEC_COMPLETE audit → spec_complete → TaskCreate allowed', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-audit-pass';
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored → spec_verified → spec_complete
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_complete');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(0); // AUTHOR complete → allowed
  });

  it('INCOMPLETE audit → stays spec_authored → TaskCreate blocked', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: INCOMPLETE\n- Task X.1 missing Test fixtures');
    const sid = 'cf-audit-fail';
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored (audit failed: stays)
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_authored');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // not spec_complete → blocked
  });
});

const gitCommit: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Bash',
  args: { command: 'git commit -m "x"' },
};

function registryExec(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerVerdictFunctions(r);
  r.register(HasActiveTask);
  r.register(WorkflowPhasesComplete);
  return r;
}

describe('builtin coding-flow pack — EXECUTE content gate (phase-logged-before-commit, FU.9)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-exec-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('ad-hoc commit (no active task) passes', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), 'cf-exec-noactive');
    expect(r.exitCode).toBe(0);
  });

  it('blocks commit when the active task has incomplete phases', async () => {
    const sid = 'cf-exec-incomplete';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), sid);
    expect(r.exitCode).toBe(2);
  });

  it('allows commit once all 7 phases are logged', async () => {
    const sid = 'cf-exec-complete';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    for (const p of REQUIRED_PHASES) await appendPhase(sid, 't1', p);
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(gitCommit, [pack], registryExec(), sid);
    expect(r.exitCode).toBe(0);
  });
});

const taskUpdateInProgress: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'TaskUpdate',
  args: { status: 'in_progress', taskId: 'X.1' },
};

function registryTaskStart(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerVerdictFunctions(r);
  r.register(HasGeneratedSpec);
  return r;
}

describe('builtin coding-flow pack — task-start hook (FU.11)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-tstart-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('task_unscoped resets to scoping from ANY state (the wildcard)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'phases_complete', 'task_unscoped')).toMatchObject({
      next: 'scoping',
      transitioned: true,
    });
    expect(step(pack.fsm!, 'spec_complete', 'task_unscoped')).toMatchObject({ next: 'scoping' });
  });

  it('activating an UNSCOPED task resets the FSM to scoping + nudges', async () => {
    const sid = 'cf-tstart-unscoped';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    await dispatchEvent(taskUpdateInProgress, [pack], registryTaskStart(), sid);
    // The RESET is the enforcement — it re-arms scope-before-code for the new task.
    // (The directive nudge, profession: scope-architect, surfaces live where that
    // persona pack is loaded; in this isolated pack it is dropped by profession
    // validation, so we assert the robust half: the reset.)
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('scoping');
  });

  it('activating a SCOPED task does NOT reset (no directive)', async () => {
    const sid = 'cf-tstart-scoped';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
      spec: resolve('package.json'),
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(taskUpdateInProgress, [pack], registryTaskStart(), sid);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('idle');
    expect(r.directives.length).toBe(0);
  });
});

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
  OpenTaskCount,
  WorkflowPhasesComplete,
} from '../../src/functions/active_task.js';
import { appendTool, writeActiveTask } from '../../src/runtime/session_state.js';
import { SessionToolHistory } from '../../src/functions/session_tool_history.js';
import { TextPatternMatch } from '../../src/functions/text_pattern_match.js';
import { appendPhase, REQUIRED_PHASES } from '../../src/runtime/workflow_phases.js';
import type { ToolCallEvent } from '../../src/runtime/types.js';
import type { PromptSubmitEvent } from '../../src/runtime/event.js';

function registry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerStateFunctions(r);
  registerVerdictFunctions(r);
  r.register(HasGeneratedSpec); // FU.12: scope-before-code now consults the active task's spec
  r.register(TextPatternMatch); // FU.3: enter-scoping classifies the track via text_pattern_match
  r.register(SessionToolHistory); // AF.1: scope-advance consults research depth
  r.register(OpenTaskCount); // AF.6: pause-prevention derives run-active
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
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE'); // AF.1: research advance now needs a GUESS_FREE audit
    const sid = 'cf-scope';
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(2); // idle + no task → blocked
    // AF.1: the research advance is gated on depth (recall+Read+Grep >= 3 this turn).
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    expect((await dispatchEvent(writeResearch, [pack], reg, sid)).exitCode).toBe(0); // → researched
    // FU.12: code also requires a scoped active task — seed one with a resolvable spec.
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
      spec: resolve('package.json'),
    });
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(0); // researched + scoped → allowed
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

describe('builtin coding-flow pack — track-type region profiles (FU.3)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-fu3-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  // A scope-authoring prompt — `enter-scoping` classifies + records coding-flow-track.
  // The fix/doc/trivial downgrade only fires when the prompt ALSO matches a scope-intent
  // keyword (the classification is gated on scope-entry), so each fixture carries both.
  const prompt = (text: string): PromptSubmitEvent => ({ kind: 'prompt_submit', prompt: text });

  it('feature track → AUTHOR gate FIRES (TaskCreate blocked before spec_complete)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-fu3-feature';
    await dispatchEvent(prompt('add a new task for the feature'), [pack], reg, sid); // track=feature
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // feature → AUTHOR fires
  });

  it('fix track → AUTHOR gate SKIPS (TaskCreate allowed at spec_authored)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-fu3-fix';
    await dispatchEvent(prompt('add a task to fix the bug'), [pack], reg, sid); // track=fix
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(0); // fix → AUTHOR skipped
  });

  it('stale fix-track RESET to feature on a later feature scope entry (fail-safe strictest)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-fu3-reset';
    await dispatchEvent(prompt('add a task to fix the bug'), [pack], reg, sid); // track=fix
    await dispatchEvent(prompt('new task to design the feature'), [pack], reg, sid); // reset → feature
    await dispatchEvent(writeResearch, [pack], reg, sid); // → researched
    await dispatchEvent(writeSpec, [pack], reg, sid); // → spec_authored
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // reset → AUTHOR fires
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
  r.register(SessionToolHistory); // AF.1: scope-advance consults research depth
  r.register(HasGeneratedSpec); // scope-before-code consults the active task's spec
  r.register(OpenTaskCount); // AF.6: pause-prevention derives run-active
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
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t); // AF.1 depth
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored → spec_verified → spec_complete
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_complete');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(0); // AUTHOR complete → allowed
  });

  it('INCOMPLETE audit → stays spec_authored → TaskCreate blocked', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: INCOMPLETE\n- Task X.1 missing Test fixtures');
    const sid = 'cf-audit-fail';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t); // AF.1 depth
    await dispatchEvent(researchWithContent, [pack], reg, sid); // → researched
    await dispatchEvent(specWithContent, [pack], reg, sid); // → spec_authored (audit failed: stays)
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_authored');
    expect((await dispatchEvent(taskCreate, [pack], reg, sid)).exitCode).toBe(2); // not spec_complete → blocked
  });
});

describe('builtin coding-flow pack — SCOPE gating: advance coupled to content (AF.1)', () => {
  let tempHome: string;
  let priorHome: string | undefined;
  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-af1-'));
    process.env.OPENSQUID_HOME = tempHome;
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  const research = (content: string): ToolCallEvent => ({
    kind: 'tool_call',
    tool: 'Write',
    args: { file_path: 'docs/research/x-pre-research-2026-06-04.md', content },
  });

  it('BLOCKS the advance while an OPEN QUESTION is unresolved (answer it in scope)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE'); // research audit → GUESS_FREE
    const sid = 'cf-af1-openq';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    const r = await dispatchEvent(
      research('# Pre-research\n\nOPEN QUESTION: which approach?'),
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(2);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).not.toBe('researched');
  });

  it('BLOCKS the advance on shallow research (depth < 3)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-af1-shallow'; // no depth seeded → count 0
    const r = await dispatchEvent(
      research('# Pre-research\n\nDerived from src/foo.ts:1.'),
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(2);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).not.toBe('researched');
  });

  it('ADVANCES only when GUESS_FREE + no open question + depth >= 3', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registryWithAudit('VERDICT: SPEC_COMPLETE');
    const sid = 'cf-af1-ok';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    const r = await dispatchEvent(
      research('# Pre-research\n\nDerived from src/foo.ts:1.'),
      [pack],
      reg,
      sid,
    );
    expect(r.exitCode).toBe(0);
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('researched');
  });

  it('AF.2: the persisted SCOPE design reaches the AUTHOR coverage audit (spec-vs-design)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    // Stub passes the AUTHOR audit ONLY if the spec-audit prompt carries the persisted
    // design marker — proving the 100%-coverage check actually sees the SCOPE design.
    const r = new FunctionRegistry();
    registerEventFunctions(r);
    registerFsmFunctions(r);
    registerStateFunctions(r);
    registerVerdictFunctions(r);
    r.register(HasGeneratedSpec);
    r.register(SessionToolHistory);
    r.register({
      name: 'subagent_call',
      argSchema: z.object({
        model: z.string(),
        prompt: z.string(),
        timeout_ms: z.number().optional(),
      }),
      durable: false,
      execute: (a: { prompt: string }) =>
        Promise.resolve(
          ok(
            a.prompt.includes('NEVER-GUESS')
              ? 'VERDICT: GUESS_FREE'
              : a.prompt.includes('DESIGN-MARKER-XYZ')
                ? 'VERDICT: SPEC_COMPLETE'
                : 'VERDICT: INCOMPLETE',
          ),
        ),
    });
    const sid = 'cf-af2-coverage';
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(research('# Pre-research with DESIGN-MARKER-XYZ'), [pack], r, sid); // → researched + persist design
    await dispatchEvent(
      {
        kind: 'tool_call',
        tool: 'Write',
        args: { file_path: 'docs/tasks/T-x.md', content: '### Task X.1' },
      },
      [pack],
      r,
      sid,
    ); // spec write → coverage audit must SEE the design marker → SPEC_COMPLETE
    expect(await readFsmState(sid, 'coding-flow', pack.fsm!)).toBe('spec_complete');
  });
});

describe('builtin coding-flow pack — pause-gates (AF.6)', () => {
  let tempHome: string;
  let priorHome: string | undefined;
  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-coding-flow-af6-'));
    process.env.OPENSQUID_HOME = tempHome;
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  const askQuestion: ToolCallEvent = { kind: 'tool_call', tool: 'AskUserQuestion', args: {} };
  const scopePrompt: PromptSubmitEvent = { kind: 'prompt_submit', prompt: 'scope a new task' };

  // research (depth + GUESS_FREE) → researched; spec write (audit INCOMPLETE) → spec_authored.
  async function toSpecAuthored(pack: Awaited<ReturnType<typeof loadPack>>, sid: string) {
    const reg = registryWithAudit('VERDICT: INCOMPLETE');
    for (const t of ['mcp__opensquid__recall', 'Read', 'Read']) await appendTool(sid, t);
    await dispatchEvent(researchWithContent, [pack], reg, sid);
    await dispatchEvent(writeSpec, [pack], reg, sid);
    return reg;
  }

  it('AskUserQuestion past SCOPE → DRIFT', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-q';
    const reg = await toSpecAuthored(pack, sid); // → spec_authored (past SCOPE)
    const r = await dispatchEvent(askQuestion, [pack], reg, sid);
    expect(r.stderr).toMatch(/DRIFT/);
  });

  it('AskUserQuestion DURING SCOPE → allowed (no drift)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-af6-qok';
    await dispatchEvent(scopePrompt, [pack], reg, sid); // → scoping
    const r = await dispatchEvent(askQuestion, [pack], reg, sid);
    expect(r.stderr).not.toMatch(/DRIFT/);
  });

  it('pause/permission language during an active run → DRIFT', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    const sid = 'cf-af6-lang';
    await dispatchEvent(scopePrompt, [pack], reg, sid); // → scoping (run active)
    const r = await dispatchEvent(
      { kind: 'prompt_submit', prompt: 'next', priorAssistantText: 'should i continue?' },
      [pack],
      reg,
      sid,
    );
    expect(r.stderr).toMatch(/DRIFT/);
  });

  it('Stop mid-run (AUTHOR/EXECUTE) → DRIFT', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const sid = 'cf-af6-stop';
    const reg = await toSpecAuthored(pack, sid); // → spec_authored
    const r = await dispatchEvent({ kind: 'stop', assistantText: '' }, [pack], reg, sid);
    expect(r.stderr).toMatch(/DRIFT/);
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

const logPhase = (phase: string): ToolCallEvent => ({
  kind: 'tool_call',
  tool: 'mcp__opensquid__log_phase',
  args: { phase },
});

function registryPhaseAudit(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerVerdictFunctions(r);
  r.register(SessionToolHistory);
  return r;
}

describe('builtin coding-flow pack — phase-audit (FU.10)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-pa-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('blocks log_phase(code) with no Write/Edit this turn', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('code'), [pack], registryPhaseAudit(), 'cf-pa-noev');
    expect(r.exitCode).toBe(2);
  });

  it('allows log_phase(code) after a Write this turn', async () => {
    const sid = 'cf-pa-ev';
    await appendTool(sid, 'Write');
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('code'), [pack], registryPhaseAudit(), sid);
    expect(r.exitCode).toBe(0);
  });

  it('blocks log_phase(test) with no Bash this turn', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('test'), [pack], registryPhaseAudit(), 'cf-pa-test');
    expect(r.exitCode).toBe(2);
  });

  it('always allows a judgment phase (learn — no mechanical proxy)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const r = await dispatchEvent(logPhase('learn'), [pack], registryPhaseAudit(), 'cf-pa-learn');
    expect(r.exitCode).toBe(0);
  });
});

describe('builtin coding-flow pack — per-write scope gate (FU.12)', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-cf-pw-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('blocks a code write with NO active task even when the FSM is past research', async () => {
    const sid = 'cf-pw-notask';
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    await dispatchEvent(writeResearch, [pack], reg, sid); // FSM → researched
    // No active task → has_generated_spec.generated === false → still blocked.
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(2);
  });

  it('blocks a code write whose active task has no spec', async () => {
    const sid = 'cf-pw-nospec';
    await writeActiveTask(sid, {
      id: 't1',
      subject: 'wip',
      started_at: '2026-06-03T00:00:00.000Z',
    });
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    const reg = registry();
    await dispatchEvent(writeResearch, [pack], reg, sid); // FSM → researched, but task unscoped
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(2);
  });
});

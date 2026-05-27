/**
 * Behavior test for the workflow gate (AP.4, rule #8).
 *
 * Like the scope-decomposer test, the gate's live home is the user's PERSONAL
 * pack (not in CI), so this loads a source-controlled fixture copy and
 * evaluates the real rule end-to-end through the pack loader (proving the
 * skill.yaml parses + every `if:` expression compiles) + the evaluator.
 *
 * The gate reads per-session state (active-task.json, automation.flag, the
 * phase ledger) under OPENSQUID_HOME/sessions/<id>/, so each case sets that
 * state in a tmp home and dispatches a synthetic `git commit` tool_call.
 *
 * Anti-fail-open anchor: the "automation + active task + incomplete phases →
 * BLOCK" case. If the gate ever silently passes an incomplete commit, it goes
 * RED. The dormancy cases (no automation / no task / complete) prove it never
 * blocks an ad-hoc or finished commit.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HasActiveTask, WorkflowPhasesComplete } from '../functions/active_task.js';
import { registerEventFunctions } from '../functions/event.js';
import { IsAutomationMode } from '../functions/is_automation_mode.js';
import { type EvalCtx, FunctionRegistry } from '../functions/registry.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import { setAutomationFlag } from '../runtime/automation_state.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import { sessionStateFile } from '../runtime/paths.js';
import { writeActiveTask, type ActiveTask } from '../runtime/session_state.js';
import { REQUIRED_PHASES } from '../runtime/workflow_phases.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const FIXTURE_PACK = resolve(HERE, '../../../test/fixtures/workflow-gate-pack');
const SID = 'wf-gate-sess';

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // tool_args, match_command, ...
  registerVerdictFunctions(reg); // verdict
  reg.register(IsAutomationMode);
  reg.register(HasActiveTask);
  reg.register(WorkflowPhasesComplete);
  return reg;
}

function ctxWith(event: Event): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: SID,
    packId: 'workflow-gate-fixture',
  };
}

const commitEvent: Event = {
  kind: 'tool_call',
  tool: 'Bash',
  args: { command: 'git commit -m x' },
  cwd: '/tmp',
};

let gateSteps: ProcessStep[];
let tempHome: string;
let priorHome: string | undefined;

async function logPhases(taskId: string, phases: readonly string[]): Promise<void> {
  const path = sessionStateFile(SID, 'workflow.phases_logged');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ task_id: taskId, phases: [...phases] }), 'utf8');
}

const ACTIVE: ActiveTask = { id: '15', subject: 'workflow', started_at: 'z', taskId: 'AP' };

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  delete process.env.OPENSQUID_AUTOMATION; // ensure flag (not env) is the automation source under test
  tempHome = await mkdtemp(join(tmpdir(), 'ap4-gate-'));
  process.env.OPENSQUID_HOME = tempHome;

  const pack = await loadPack(FIXTURE_PACK);
  const skill = pack.skills.find((s) => s.name === 'workflow');
  if (!skill) throw new Error('workflow skill not found in fixture pack');
  const rule = skill.rules.find((r) => r.id === 'workflow-phases-required');
  if (rule?.kind !== 'track_check') throw new Error('workflow-phases-required not a track_check');
  gateSteps = rule.process;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

async function run(event: Event): Promise<RuleResult> {
  return evaluateProcess(gateSteps, ctxWith(event), buildTestRegistry());
}

describe('workflow gate (fixture) / workflow-phases-required', () => {
  it('BLOCKS a git commit when automation + active task + phases incomplete (anti-fail-open anchor)', async () => {
    await setAutomationFlag(SID);
    await writeActiveTask(SID, ACTIVE);
    await logPhases('15', REQUIRED_PHASES.slice(0, 6)); // 6 of 7

    const r = await run(commitEvent);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('PASSES once all 7 phases are logged for the active task', async () => {
    await setAutomationFlag(SID);
    await writeActiveTask(SID, ACTIVE);
    await logPhases('15', REQUIRED_PHASES);

    expect((await run(commitEvent)).kind).toBe('no_verdict');
  });

  it('is DORMANT when automation mode is off (interactive commit, even with incomplete phases)', async () => {
    // no armAutomation()
    await writeActiveTask(SID, ACTIVE);
    await logPhases('15', REQUIRED_PHASES.slice(0, 2));

    expect((await run(commitEvent)).kind).toBe('no_verdict');
  });

  it('is DORMANT when there is no active task (ad-hoc commit in automation)', async () => {
    await setAutomationFlag(SID);
    // no writeActiveTask
    expect((await run(commitEvent)).kind).toBe('no_verdict');
  });

  it('does not block a non-commit Bash call', async () => {
    await setAutomationFlag(SID);
    await writeActiveTask(SID, ACTIVE);
    await logPhases('15', REQUIRED_PHASES.slice(0, 1));

    const r = await run({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'ls -la' },
      cwd: '/tmp',
    });
    expect(r.kind).toBe('no_verdict');
  });

  it('BLOCKS when the phase ledger is for a now-inactive task (no inheritance)', async () => {
    await setAutomationFlag(SID);
    await writeActiveTask(SID, ACTIVE); // active = 15
    await logPhases('14', REQUIRED_PHASES); // all 7, but for the PRIOR task 14

    const r = await run(commitEvent);
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });
});

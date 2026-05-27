/**
 * Behavior test for scope→task Gate A (scope-before-code, AP.5).
 *
 * Loads the source-controlled fixture copy through the real pack loader
 * (proving the skill.yaml parses + every `if:` compiles) and evaluates the rule
 * against controlled per-session state in a tmp OPENSQUID_HOME.
 *
 * Anti-fail-open anchor: "automation + code-write + no generated task → BLOCK."
 * Dormancy cases prove it never blocks the act of SCOPING (docs/tasks,
 * docs/research writes) nor interactive editing nor a properly-scoped task.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HasActiveTask,
  HasGeneratedSpec,
  WorkflowPhasesComplete,
} from '../functions/active_task.js';
import { registerEventFunctions } from '../functions/event.js';
import { IsAutomationMode } from '../functions/is_automation_mode.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import { setAutomationFlag } from '../runtime/automation_state.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import { writeActiveTask, type ActiveTask } from '../runtime/session_state.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const FIXTURE_PACK = resolve(HERE, '../../../test/fixtures/scope-gates-pack');
const SID = 'scope-gate-sess';

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // tool_name, tool_args, contains, ...
  registerVerdictFunctions(reg);
  reg.register(IsAutomationMode);
  reg.register(HasActiveTask);
  reg.register(WorkflowPhasesComplete);
  reg.register(HasGeneratedSpec);
  return reg;
}

function codeWrite(filePath: string): Event {
  return {
    kind: 'tool_call',
    tool: 'Write',
    args: { file_path: filePath, content: 'x' },
    cwd: '/tmp',
  };
}

let gateSteps: ProcessStep[];
let tempHome: string;
let priorHome: string | undefined;
let specPath: string;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  delete process.env.OPENSQUID_AUTOMATION;
  tempHome = await mkdtemp(join(tmpdir(), 'ap5-gateA-'));
  process.env.OPENSQUID_HOME = tempHome;
  specPath = join(tempHome, 'T-track.md'); // an absolute spec path (H7)
  await writeFile(specPath, '### Task X.1', 'utf8');

  const pack = await loadPack(FIXTURE_PACK);
  const skill = pack.skills.find((s) => s.name === 'scope-decomposer');
  const rule = skill?.rules.find((r) => r.id === 'scope-before-code');
  if (rule?.kind !== 'track_check') throw new Error('scope-before-code not a track_check');
  gateSteps = rule.process;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

async function run(event: Event): Promise<RuleResult> {
  return evaluateProcess(
    gateSteps,
    { event, bindings: new Map(), sessionId: SID, packId: 'scope-gates-fixture' },
    buildTestRegistry(),
  );
}

const GENERATED: ActiveTask = { id: '15', subject: 'x', started_at: 'z', taskId: 'X' };

describe('scope→task Gate A (fixture) / scope-before-code', () => {
  it('BLOCKS a src/ write when automation + no active task (anti-fail-open anchor)', async () => {
    await setAutomationFlag(SID);
    // no active task → no provenance → block "scope it first"
    const r = await run(codeWrite('src/foo.ts'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('BLOCKS a src/ write when the active task has no generated spec', async () => {
    await setAutomationFlag(SID);
    await writeActiveTask(SID, { id: '15', subject: 'x', started_at: 'z' }); // no spec
    const r = await run(codeWrite('src/foo.ts'));
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('PASSES a src/ write when the active task has a resolving spec (generated)', async () => {
    await setAutomationFlag(SID);
    await writeActiveTask(SID, { ...GENERATED, spec: specPath });
    expect((await run(codeWrite('src/foo.ts'))).kind).toBe('no_verdict');
  });

  it('does NOT block writing the spec itself (docs/tasks) — scoping is never gated', async () => {
    await setAutomationFlag(SID);
    // no active task, but this is a docs/tasks write (the act of scoping)
    expect((await run(codeWrite('docs/tasks/T-track.md'))).kind).toBe('no_verdict');
  });

  it('does NOT block writing pre-research (docs/research) — scoping is never gated', async () => {
    await setAutomationFlag(SID);
    expect((await run(codeWrite('docs/research/T-track-pre-research-2026-05-27.md'))).kind).toBe(
      'no_verdict',
    );
  });

  it('is DORMANT in interactive mode (automation off) — never blocks ad-hoc src edits', async () => {
    // no setAutomationFlag
    const r = await run(codeWrite('src/foo.ts'));
    expect(r.kind).toBe('no_verdict');
  });
});

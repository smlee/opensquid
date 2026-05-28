/**
 * Behavior test for the scope-decomposer skill (Track SD.8).
 *
 * The skill's live home is the user's PERSONAL pack
 * (~/.opensquid/codexes/sangmin-personal-rules/), which is not in CI, and the
 * builtin tree deliberately excludes it (personal ≠ shipping, commit 1fb64ac).
 * So this test loads a source-controlled COPY from test/fixtures/ and evaluates
 * the skill's real rules end-to-end. The no-artifact block case is the
 * anti-fail-open anchor: if the gate ever silently passes a genuine inline-spec,
 * that test goes RED.
 *
 * path_exists resolves its `dir` against `ctx.event.cwd`, so each tool_call
 * fixture sets `cwd` to a tmp dir that either has or lacks the pre-research file.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HasActiveTask, WorkflowPhasesComplete } from '../functions/active_task.js';
import { ReadChainState } from '../functions/chain_state.js';
import { registerEventFunctions } from '../functions/event.js';
import { PathExists } from '../functions/path_exists.js';
import { type EvalCtx, FunctionRegistry } from '../functions/registry.js';
import { TextPatternMatch } from '../functions/text_pattern_match.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import { transitionChainStage } from '../runtime/chain_state.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import { writeActiveTask, type ActiveTask } from '../runtime/session_state.js';
import { RequiresCache, skillRequiresHold, type SkillRequires } from '../runtime/skill_requires.js';
import type { ProcessStep, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
// repo-root/test/fixtures/scope-decomposer-pack
const FIXTURE_PACK = resolve(HERE, '../../../test/fixtures/scope-decomposer-pack');

function buildTestRegistry(): FunctionRegistry {
  const reg = new FunctionRegistry();
  registerEventFunctions(reg); // tool_name, tool_args, cwd, ...
  registerVerdictFunctions(reg); // verdict
  reg.register(TextPatternMatch);
  reg.register(PathExists);
  // T-ASC ASC.5 primitives the chain-handoff rules call.
  reg.register(ReadChainState);
  reg.register(HasActiveTask);
  reg.register(WorkflowPhasesComplete);
  return reg;
}

function ctxWith(event: Event): EvalCtx {
  return {
    event,
    bindings: new Map<string, unknown>(),
    sessionId: 's',
    packId: 'scope-decomposer-fixture',
  };
}

async function runRule(process: ProcessStep[], event: Event): Promise<RuleResult> {
  return evaluateProcess(process, ctxWith(event), buildTestRegistry());
}

let nudgeSteps: ProcessStep[];
let blockSteps: ProcessStep[];
// T-ASC ASC.5 chain-handoff rules + their per-rule requires.
let r1Steps: ProcessStep[];
let r1Requires: readonly SkillRequires[];
let r2Steps: ProcessStep[];
let r2Requires: readonly SkillRequires[];
let r3Steps: ProcessStep[];
let r3Requires: readonly SkillRequires[];
let tmpNoArtifact: string;
let tmpWithArtifact: string;

beforeAll(async () => {
  const pack = await loadPack(FIXTURE_PACK);
  const skill = pack.skills.find((s) => s.name === 'scope-decomposer');
  if (!skill) throw new Error('scope-decomposer skill not found in fixture pack');
  const nudge = skill.rules.find((r) => r.id === 'scope-intent-nudge');
  const block = skill.rules.find((r) => r.id === 'inline-spec-block');
  if (nudge?.kind !== 'track_check') throw new Error('scope-intent-nudge not a track_check');
  if (block?.kind !== 'track_check') throw new Error('inline-spec-block not a track_check');
  nudgeSteps = nudge.process;
  blockSteps = block.process;
  // ASC.5: locate the 3 chain-handoff rules + their per-rule requires.
  const r1 = skill.rules.find((r) => r.id === 'chain-handoff-research-to-spec');
  const r2 = skill.rules.find((r) => r.id === 'chain-handoff-spec-to-tasks');
  const r3 = skill.rules.find((r) => r.id === 'chain-handoff-resume-phases');
  if (r1?.kind !== 'track_check')
    throw new Error('chain-handoff-research-to-spec not a track_check');
  if (r2?.kind !== 'track_check') throw new Error('chain-handoff-spec-to-tasks not a track_check');
  if (r3?.kind !== 'track_check') throw new Error('chain-handoff-resume-phases not a track_check');
  r1Steps = r1.process;
  r1Requires = r1.requires;
  r2Steps = r2.process;
  r2Requires = r2.requires;
  r3Steps = r3.process;
  r3Requires = r3.requires;

  tmpNoArtifact = await mkdtemp(join(tmpdir(), 'sd8-no-artifact-'));
  await mkdir(join(tmpNoArtifact, 'docs', 'tasks'), { recursive: true });

  tmpWithArtifact = await mkdtemp(join(tmpdir(), 'sd8-with-artifact-'));
  await mkdir(join(tmpWithArtifact, 'docs', 'research'), { recursive: true });
  await mkdir(join(tmpWithArtifact, 'docs', 'tasks'), { recursive: true });
  await writeFile(
    join(tmpWithArtifact, 'docs', 'research', 'T-foo-pre-research-2026-05-26.md'),
    '# pre-research',
  );
});

afterAll(async () => {
  await rm(tmpNoArtifact, { recursive: true, force: true });
  await rm(tmpWithArtifact, { recursive: true, force: true });
});

const SPEC_BODY = '### Task FOO.1\n\n**Deliverable:** ship the thing\n**Required skills:** X';

describe('scope-decomposer (fixture) / scope-intent-nudge', () => {
  it('warns on scope-authoring intent', async () => {
    const r = await runRule(nudgeSteps, {
      kind: 'prompt_submit',
      prompt: 'spec out a new track for the memory fix',
    });
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('warn');
  });

  it('stays silent on a non-scope prompt', async () => {
    const r = await runRule(nudgeSteps, {
      kind: 'prompt_submit',
      prompt: 'what is the weather today',
    });
    expect(r.kind).toBe('no_verdict');
  });
});

describe('scope-decomposer (fixture) / inline-spec-block', () => {
  it('BLOCKS a spec Write with no pre-research artifact (anti-fail-open anchor)', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/tasks/T-foo.md', content: SPEC_BODY },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('passes a spec Write when a pre-research artifact is present', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/tasks/T-foo.md', content: SPEC_BODY },
      cwd: tmpWithArtifact,
    });
    expect(r.kind).toBe('no_verdict');
  });

  it('BLOCKS an Edit that injects a task block into TASKS.md with no artifact', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Edit',
      args: { file_path: 'TASKS.md', old_string: 'x', new_string: SPEC_BODY },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('passes a non-spec Write (src/**)', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'src/foo.ts', content: 'export const x = 1;' },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('no_verdict');
  });

  it('passes a prose-only Write to a spec destination (no task markers)', async () => {
    const r = await runRule(blockSteps, {
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/tasks/T-foo.md', content: 'just some prose, no task markers here' },
      cwd: tmpNoArtifact,
    });
    expect(r.kind).toBe('no_verdict');
  });
});

// ---------------------------------------------------------------------------
// T-ASC ASC.5 — chain-handoff rules.
//
// Each rule is gated at the dispatcher boundary by per-rule `requires:
// chain_stage`. Tests mimic the dispatcher flow: read rule.requires, gate
// via skillRequiresHold against the isolated tmp HOME's chain-state, then
// walk the rule body. Three rules × (gate-passes-fire + gate-fails-silent +
// edge case) = 9+ cases.
//
// Each test uses a fresh OPENSQUID_HOME via mkdtemp inside beforeEach so the
// chain-state file and active-task file are scoped per case.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach } from 'vitest';
import { mkdtemp as mkdtempH, rm as rmH } from 'node:fs/promises';
import { tmpdir as tmpdirH } from 'node:os';
import { join as joinH } from 'node:path';

describe('scope-decomposer (fixture) / chain-handoff rules (T-ASC ASC.5)', () => {
  let chainTmpHome: string;
  let priorChainHome: string | undefined;
  const SID = 'asc5-chain-sess';

  async function runChainRule(
    steps: ProcessStep[],
    requires: readonly SkillRequires[],
  ): Promise<RuleResult> {
    // Mimic the dispatcher: per-rule requires evaluated FIRST; if false,
    // the rule body never walks (no_verdict).
    const hold = await skillRequiresHold(requires, SID, new RequiresCache());
    if (!hold) return { kind: 'no_verdict' };
    return evaluateProcess(
      steps,
      {
        event: { kind: 'prompt_submit', prompt: 'p' },
        bindings: new Map(),
        sessionId: SID,
        packId: 'p',
      },
      buildTestRegistry(),
    );
  }

  beforeEach(async () => {
    priorChainHome = process.env.OPENSQUID_HOME;
    chainTmpHome = await mkdtempH(joinH(tmpdirH(), 'asc5-chain-'));
    process.env.OPENSQUID_HOME = chainTmpHome;
  });

  afterEach(async () => {
    if (priorChainHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorChainHome;
    await rmH(chainTmpHome, { recursive: true, force: true });
  });

  // E1 — chain-handoff-research-to-spec
  describe('chain-handoff-research-to-spec (researched → task-spec-author)', () => {
    it('emits directive when chain is researched', async () => {
      await transitionChainStage(SID, 'researched', { pre_research_path: '/abs/p.md' });
      const r = await runChainRule(r1Steps, r1Requires);
      expect(r.kind).toBe('directive');
      if (r.kind === 'directive') {
        expect(r.directive.next_action.skill).toBe('task-spec-author');
        expect(r.directive.next_action.rationale).toContain('researched');
      }
    });

    it('stays silent when chain is idle (precondition fails)', async () => {
      const r = await runChainRule(r1Steps, r1Requires);
      expect(r.kind).toBe('no_verdict');
    });

    it('stays silent when chain has advanced to spec_authored', async () => {
      await transitionChainStage(SID, 'researched', { pre_research_path: '/abs/p.md' });
      await transitionChainStage(SID, 'spec_authored', { spec_path: '/abs/T-x.md' });
      const r = await runChainRule(r1Steps, r1Requires);
      expect(r.kind).toBe('no_verdict');
    });
  });

  // E2 — chain-handoff-spec-to-tasks
  describe('chain-handoff-spec-to-tasks (spec_authored → TaskCreate)', () => {
    it('emits directive when chain is spec_authored', async () => {
      await transitionChainStage(SID, 'spec_authored', { spec_path: '/abs/T-x.md' });
      const r = await runChainRule(r2Steps, r2Requires);
      expect(r.kind).toBe('directive');
      if (r.kind === 'directive') {
        expect(r.directive.next_action.tool).toBe('TaskCreate');
        expect(r.directive.next_action.rationale).toContain('spec_authored');
      }
    });

    it('stays silent when chain is tasks_loaded (next stage)', async () => {
      await transitionChainStage(SID, 'spec_authored');
      await transitionChainStage(SID, 'tasks_loaded', { task_ids: ['t1'] });
      const r = await runChainRule(r2Steps, r2Requires);
      expect(r.kind).toBe('no_verdict');
    });

    it('stays silent when chain is idle', async () => {
      const r = await runChainRule(r2Steps, r2Requires);
      expect(r.kind).toBe('no_verdict');
    });
  });

  // E3 — chain-handoff-resume-phases
  describe('chain-handoff-resume-phases (phases_in_flight → log_phase)', () => {
    const ACTIVE: ActiveTask = {
      id: '99',
      subject: 'asc5-probe',
      started_at: new Date().toISOString(),
    };

    it('emits directive when chain is phases_in_flight + 7-phase incomplete', async () => {
      await transitionChainStage(SID, 'phases_in_flight');
      await writeActiveTask(SID, ACTIVE);
      // No phases logged → workflow_phases_complete returns complete:false.
      const r = await runChainRule(r3Steps, r3Requires);
      expect(r.kind).toBe('directive');
      if (r.kind === 'directive') {
        expect(r.directive.next_action.tool).toBe('mcp__opensquid__log_phase');
      }
    });

    it('stays silent when chain is idle (precondition fails)', async () => {
      const r = await runChainRule(r3Steps, r3Requires);
      expect(r.kind).toBe('no_verdict');
    });
  });
});

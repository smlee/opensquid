/**
 * Rule-FIRING test for the coding-flow `execute-gate` docs-only parity
 * (T-commit-nudge-docsonly-parity extension, wg-3dcca3b29ed1).
 *
 * The execute-gate is the SECOND commit gate (the default-discipline `workflow` nudge is the
 * first). It blocks a `git commit` while the active task's 7-phase flow is incomplete — but it
 * must MIRROR the git-owned hard gate (gate.ts isDocsOnly): a docs-only commit is NOT blocked,
 * even mid-flow. Exercises the real rule process end-to-end against a real git index + real
 * session state (FSM + active-task + phase ledger).
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HasActiveTask, WorkflowPhasesComplete } from '../functions/active_task.js';
import { registerEventFunctions } from '../functions/event.js';
import { registerFsmFunctions } from '../functions/fsm.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerStagedDocsOnlyFunction } from '../functions/staged_docs_only.js';
import { registerStateFunctions } from '../functions/state.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { Rule, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const execFileP = promisify(execFile);
const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/coding-flow');
const SID = 'execgate-sess';

let repo: string;
let home: string;
const savedHome = process.env.OPENSQUID_HOME;

async function git(args: string[], cwd: string): Promise<void> {
  await execFileP('git', args, { cwd });
}
async function stage(rel: string): Promise<void> {
  const abs = join(repo, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, 'x\n');
  await git(['add', rel], repo);
}
async function sessionFile(rel: string, body: unknown): Promise<void> {
  const dir = join(home, 'sessions', SID);
  await mkdir(join(dir, rel, '..'), { recursive: true });
  await writeFile(join(dir, rel), JSON.stringify(body));
}
/** FSM past-author (so the mid-flow block does not fire) + active task + N logged phases. */
async function setState(fsmState: string, phaseCount: number): Promise<void> {
  await sessionFile('state/fsm-coding-flow.json', { state: fsmState, started_at: '', history: [] });
  await sessionFile('active-task.json', { id: 't', subject: 's', started_at: '', taskId: 't' });
  const phases = ['pre_research', 'learn', 'code', 'test', 'audit', 'post_research', 'fix'].slice(
    0,
    phaseCount,
  );
  await sessionFile('state/workflow.phases_logged.json', { task_id: 't', phases });
}

async function loadRule(): Promise<Rule> {
  const pack = await loadPack(PACK);
  const skill = pack.skills.find((s) => s.name === 'execute-gate');
  const rule = skill?.rules.find((r) => r.id === 'phase-logged-before-commit');
  if (rule === undefined) throw new Error('execute-gate phase-logged-before-commit rule not found');
  return rule;
}

function run(rule: Rule, event: Event): Promise<RuleResult> {
  if (rule.kind !== 'track_check') throw new Error('rule must be track_check');
  const reg = new FunctionRegistry();
  registerEventFunctions(reg);
  registerFsmFunctions(reg);
  registerStateFunctions(reg);
  registerVerdictFunctions(reg);
  registerStagedDocsOnlyFunction(reg);
  reg.register(HasActiveTask);
  reg.register(WorkflowPhasesComplete);
  return evaluateProcess(
    rule.process,
    { event, bindings: new Map(), sessionId: SID, packId: 'coding-flow' },
    reg,
  );
}

const commit = (): Event => ({
  kind: 'tool_call',
  tool: 'Bash',
  args: { command: 'git commit -m x' },
  cwd: repo,
});

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'opensquid-execgate-repo-'));
  home = await mkdtemp(join(tmpdir(), 'opensquid-execgate-home-'));
  process.env.OPENSQUID_HOME = home;
  await git(['init', '-q'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 't'], repo);
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  await rm(repo, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('execute-gate phase-logged-before-commit — docs-only parity (wg-3dcca3b29ed1)', () => {
  it('does NOT block a docs-only commit even with active task + incomplete phases', async () => {
    await setState('tasks_loaded', 0); // active task, 0 phases → would block a code commit
    await stage('docs/handover.md');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('no_verdict');
  });

  it('STILL blocks a CODE commit with active task + incomplete phases (no regression)', async () => {
    await setState('tasks_loaded', 0);
    await stage('src/a.ts');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('does NOT block a docs-only commit mid-flow (scoping) either', async () => {
    await setState('scoping', 0);
    await stage('docs/x.md');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('no_verdict');
  });

  it('STILL blocks a CODE commit mid-flow (scoping) — authoring-incomplete (no regression)', async () => {
    await setState('scoping', 0);
    await stage('src/a.ts');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('does NOT block a 7-phase code commit (baseline unchanged)', async () => {
    await setState('tasks_loaded', 7);
    await stage('src/a.ts');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('no_verdict');
  });
});

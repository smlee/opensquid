/**
 * Rule-firing test for `no-question-after-scope` (BUG-FIX wg-96e35185572a).
 *
 * The hard-block on AskUserQuestion past SCOPE must switch OFF when the backlog is DEPLETED
 * (FSM at `phases_complete` with zero open tasks) — a new question is then legitimate — exactly
 * like the sibling `no-pause-language` rule's `(open.count > 0 || st != "phases_complete")` guard.
 * Mid-flow, or with open work remaining, the block STILL fires (no regression).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenTaskCount } from '../functions/active_task.js';
import { registerEventFunctions } from '../functions/event.js';
import { registerFsmFunctions } from '../functions/fsm.js';
import { registerPhaseBundleText } from '../functions/phase_bundle_text.js';
import { FunctionRegistry } from '../functions/registry.js';
import { registerVerdictFunctions } from '../functions/verdict.js';
import type { Event } from '../runtime/event.js';
import { evaluateProcess } from '../runtime/evaluator.js';
import type { Fsm } from '../runtime/fsm.js';
import { sessionStateFile } from '../runtime/paths.js';
import type { Rule, RuleResult } from '../runtime/types.js';

import { loadPack } from './loader.js';

const HERE = fileURLToPath(import.meta.url);
const PACK = resolve(HERE, '../../../packs/builtin/coding-flow');
const SID = 'pause-prev-sess';

let home: string;
let tasksDir: string;
let fsm: Fsm;
let rule: Rule;
const savedHome = process.env.OPENSQUID_HOME;
const savedTasks = process.env.OPENSQUID_HARNESS_TASKS_DIR;

async function setFsmState(state: string): Promise<void> {
  const f = sessionStateFile(SID, 'fsm-coding-flow');
  await mkdir(join(f, '..'), { recursive: true });
  await writeFile(f, JSON.stringify({ state, history: [] }), 'utf8');
}
async function setOpenTasks(n: number): Promise<void> {
  const dir = join(tasksDir, SID);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    await writeFile(
      join(dir, `t${i}.json`),
      JSON.stringify({ id: `t${i}`, subject: `task ${i}`, status: 'pending' }),
      'utf8',
    );
  }
}

const ask: Event = { kind: 'tool_call', tool: 'AskUserQuestion', args: {}, cwd: '/tmp' };

function run(): Promise<RuleResult> {
  if (rule.kind !== 'track_check') throw new Error('no-question-after-scope must be track_check');
  const reg = new FunctionRegistry();
  registerEventFunctions(reg);
  registerFsmFunctions(reg);
  registerVerdictFunctions(reg);
  registerPhaseBundleText(reg);
  reg.register(OpenTaskCount);
  return evaluateProcess(
    rule.process,
    { event: ask, bindings: new Map(), sessionId: SID, packId: 'coding-flow', packFsm: fsm },
    reg,
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-pp-home-'));
  tasksDir = await mkdtemp(join(tmpdir(), 'opensquid-pp-tasks-'));
  process.env.OPENSQUID_HOME = home;
  process.env.OPENSQUID_HARNESS_TASKS_DIR = tasksDir;
  const pack = await loadPack(PACK);
  if (pack.fsm === undefined) throw new Error('coding-flow fsm missing');
  fsm = pack.fsm;
  const skill = pack.skills.find((s) => s.name === 'pause-prevention');
  const r = skill?.rules.find((x) => x.id === 'no-question-after-scope');
  if (r === undefined) throw new Error('no-question-after-scope rule not found');
  rule = r;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  if (savedTasks === undefined) delete process.env.OPENSQUID_HARNESS_TASKS_DIR;
  else process.env.OPENSQUID_HARNESS_TASKS_DIR = savedTasks;
  await rm(home, { recursive: true, force: true });
  await rm(tasksDir, { recursive: true, force: true });
});

describe('no-question-after-scope — depleted-backlog allowance (wg-96e35185572a)', () => {
  it('ALLOWS AskUserQuestion at phases_complete with the backlog depleted (open 0)', async () => {
    await setFsmState('phases_complete');
    await setOpenTasks(0);
    const r = await run();
    expect(r.kind).toBe('no_verdict');
  });

  it('STILL blocks AskUserQuestion mid-flow (spec_complete)', async () => {
    await setFsmState('spec_complete');
    await setOpenTasks(0);
    const r = await run();
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('STILL blocks at phases_complete when open work remains (open > 0)', async () => {
    await setFsmState('phases_complete');
    await setOpenTasks(1);
    const r = await run();
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });
});

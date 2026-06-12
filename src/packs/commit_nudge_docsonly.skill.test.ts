/**
 * Rule-FIRING test for `phase-logged-before-commit` (wg-3dcca3b29ed1, DOCSONLY.1).
 *
 * The nudge must MIRROR the git-owned hard gate (gate.ts isDocsOnly): block a
 * zero-phase CODE commit, but NOT a zero-phase docs-only commit. Exercises the
 * real rule process end-to-end through the evaluator, against a real git index
 * and real session state.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../functions/event.js';
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
const PACK = resolve(HERE, '../../../packs/builtin/default-discipline');
const SID = 'docsonly-sess';

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
/** Write the workflow.phases_logged session-state ledger with `n` phases. */
async function setPhases(n: number): Promise<void> {
  const dir = join(home, 'sessions', SID, 'state');
  await mkdir(dir, { recursive: true });
  const phases = ['pre_research', 'learn', 'code', 'test', 'audit', 'post_research', 'fix'].slice(
    0,
    n,
  );
  await writeFile(
    join(dir, 'workflow.phases_logged.json'),
    JSON.stringify({ task_id: 't', phases }),
  );
}

async function loadRule(): Promise<Rule> {
  const pack = await loadPack(PACK);
  const skill = pack.skills.find((s) => s.name === 'workflow');
  const rule = skill?.rules.find((r) => r.id === 'phase-logged-before-commit');
  if (rule === undefined) throw new Error('phase-logged-before-commit rule not found');
  return rule;
}

function run(rule: Rule, event: Event): Promise<RuleResult> {
  if (rule.kind !== 'track_check')
    throw new Error('phase-logged-before-commit must be track_check');
  const reg = new FunctionRegistry();
  registerEventFunctions(reg);
  registerStateFunctions(reg);
  registerVerdictFunctions(reg);
  registerStagedDocsOnlyFunction(reg);
  return evaluateProcess(
    rule.process,
    { event, bindings: new Map(), sessionId: SID, packId: 'default-discipline' },
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
  repo = await mkdtemp(join(tmpdir(), 'opensquid-cnd-repo-'));
  home = await mkdtemp(join(tmpdir(), 'opensquid-cnd-home-'));
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

describe('phase-logged-before-commit — docs-only parity (wg-3dcca3b29ed1)', () => {
  it('does NOT block a zero-phase DOCS-ONLY commit', async () => {
    await setPhases(0);
    await stage('docs/handover.md');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('no_verdict');
  });

  it('STILL blocks a zero-phase CODE commit (no regression)', async () => {
    await setPhases(0);
    await stage('src/a.ts');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('verdict');
    if (r.kind === 'verdict') expect(r.verdict.level).toBe('block');
  });

  it('does NOT block a 7-phase code commit (baseline unchanged)', async () => {
    await setPhases(7);
    await stage('src/a.ts');
    const r = await run(await loadRule(), commit());
    expect(r.kind).toBe('no_verdict');
  });

  it('committing===false (S1): a non-commit command is silent, no unset-var error', async () => {
    await setPhases(0);
    await stage('src/a.ts'); // code staged, but this is not a commit
    const lsEvent: Event = {
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'ls -la' },
      cwd: repo,
    };
    const r = await run(await loadRule(), lsEvent);
    expect(r.kind).toBe('no_verdict');
  });
});

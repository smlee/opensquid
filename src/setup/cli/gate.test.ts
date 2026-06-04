import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPack } from '../../packs/loader.js';
import { advanceFsmState } from '../../runtime/fsm_state.js';
import { writeActiveTask } from '../../runtime/session_state.js';
import { appendPhase, REQUIRED_PHASES } from '../../runtime/workflow_phases.js';

import { isGatedRepo, runGate } from './gate.js';

const execFileP = promisify(execFile);
const SID = 'gate-test-session';
const NOW = '2026-06-04T00:00:00.000Z';

let tempHome: string;
let repo: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'OPENSQUID_HOME',
  'OPENSQUID_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileP('git', args, { cwd });
}

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-gate-home-'));
  repo = await mkdtemp(join(tmpdir(), 'opensquid-gate-repo-'));
  process.env.OPENSQUID_HOME = tempHome;
  process.env.OPENSQUID_SESSION_ID = SID; // resolveMcpSessionId precedence #2 (deterministic)
  await git(['init', '-q'], repo);
  await git(['config', 'user.email', 't@t'], repo);
  await git(['config', 'user.name', 't'], repo);
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(tempHome, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

async function makeGated(): Promise<void> {
  await mkdir(join(repo, '.opensquid'), { recursive: true });
  await writeFile(
    join(repo, '.opensquid', 'active.json'),
    JSON.stringify({ packs: ['coding-flow'] }),
    'utf8',
  );
}
async function stage(path: string): Promise<void> {
  const full = join(repo, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, 'x\n', 'utf8');
  await git(['add', path], repo);
}
/** Seed the live session so the gate sees a completed flow for active task `t1`. */
async function driveComplete(): Promise<void> {
  const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
  await writeActiveTask(SID, { id: 't1', subject: 'wip', started_at: NOW });
  for (const p of REQUIRED_PHASES) await appendPhase(SID, 't1', p);
  for (const ev of [
    'scope_start',
    'research_done',
    'spec_drafted',
    'spec_verified',
    'tasks_loaded',
    'phase_started',
    'phases_done',
  ])
    await advanceFsmState(SID, 'coding-flow', pack.fsm!, ev, NOW); // → phases_complete
}

describe('GF.2 — owned-boundary git gate (runGate "commit")', () => {
  it('non-gated repo (no active.json) → ALLOW (0)', async () => {
    await stage('src/x.ts');
    expect(await isGatedRepo(repo)).toBe(false);
    expect(await runGate('commit', repo)).toBe(0);
  });

  it('gated repo, code staged, flow NOT complete → BLOCK (2)', async () => {
    await makeGated();
    await stage('src/x.ts'); // no session state seeded → active/fsm absent
    expect(await isGatedRepo(repo)).toBe(true);
    expect(await runGate('commit', repo)).toBe(2);
  });

  it('gated repo, code staged, flow COMPLETE → ALLOW (0)', async () => {
    await makeGated();
    await stage('src/x.ts');
    await driveComplete();
    expect(await runGate('commit', repo)).toBe(0);
  });

  it('gated repo, docs-only staged → ALLOW (flow artifact)', async () => {
    await makeGated();
    await stage('docs/research/T-x-pre-research.md');
    expect(await runGate('commit', repo)).toBe(0);
  });

  it('gated repo, nothing staged → ALLOW (0)', async () => {
    await makeGated();
    expect(await runGate('commit', repo)).toBe(0);
  });

  it('gated repo, code staged, NO resolvable session → BLOCK (2)', async () => {
    await makeGated();
    await stage('src/x.ts');
    delete process.env.OPENSQUID_SESSION_ID; // and no .current-session pointer under tempHome
    expect(await runGate('commit', repo)).toBe(2);
  });
});

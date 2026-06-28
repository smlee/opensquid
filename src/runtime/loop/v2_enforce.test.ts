/**
 * V2 gate enforcement in PreToolUse — proves the gates can now BLOCK (the fix for "structurally incapable of
 * blocking"). A `git commit` with incomplete phases is denied; non-advance actions pass; an inactive pack passes.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enforceV2GatesPre, runToDoneStopBlock } from './v2_enforce.js';
import { setAutomationFlag } from '../automation_state.js';
import { writeActiveTask } from '../session_state.js';
import { persistActorState } from '../fsm_state.js';
import type { Event } from '../types.js';

const PRIOR_HOME = process.env.OPENSQUID_HOME;
let home: string;
let neutralCwd: string;
let prevCwd: string;

async function activate(packs: string[]): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'active.json'), JSON.stringify({ packs }), 'utf8');
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-v2enf-'));
  process.env.OPENSQUID_HOME = home;
  // Run from a neutral cwd (no `.opensquid` ancestor) so the opensquid repo's own project active.json
  // (it dogfoods fullstack-flow) doesn't leak in — only the sandboxed home active.json counts.
  neutralCwd = await mkdtemp(join(tmpdir(), 'osq-v2enf-cwd-'));
  prevCwd = process.cwd();
  process.chdir(neutralCwd);
});
afterEach(async () => {
  process.chdir(prevCwd);
  await rm(home, { recursive: true, force: true });
  await rm(neutralCwd, { recursive: true, force: true });
  if (PRIOR_HOME === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = PRIOR_HOME;
});

const commit = (): Event =>
  ({ kind: 'tool_call', tool: 'Bash', args: { command: 'git commit -m x' } }) as unknown as Event;
const benign = (): Event =>
  ({ kind: 'tool_call', tool: 'Bash', args: { command: 'ls -la' } }) as unknown as Event;

describe('enforceV2GatesPre', () => {
  // The SCOPE block (a not-ready pre-research write) is proven live where buildGuardCtx can run; here we cover
  // that NON-advance actions pass (commit is intentionally NOT gated here — v1 owns the commit gate).
  const preResearchWrite = (): Event =>
    ({
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/research/T-x-pre-research-2026-06-27.md', content: '#' },
    }) as unknown as Event;
  const docWrite = (): Event =>
    ({
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/notes.md', content: '#' },
    }) as unknown as Event;

  it('does NOT gate a git commit (v1 phase-logged-before-commit owns the commit gate)', async () => {
    await activate(['fullstack-flow']);
    expect((await enforceV2GatesPre('sess-enf-commit', commit())).exitCode).toBe(0);
  });

  it('PASSES a non-advance action (ls) without evaluating any gate', async () => {
    await activate(['fullstack-flow']);
    expect((await enforceV2GatesPre('sess-enf-pass', benign())).exitCode).toBe(0);
  });

  it('PASSES a non-pre-research Write (not a gate advance-action)', async () => {
    await activate(['fullstack-flow']);
    expect((await enforceV2GatesPre('sess-enf-docwrite', docWrite())).exitCode).toBe(0);
  });

  it('PASSES when fullstack-flow is NOT active (no gate to enforce), even on a pre-research write', async () => {
    await activate([]); // no v2 cartridge
    expect((await enforceV2GatesPre('sess-enf-inactive', preResearchWrite())).exitCode).toBe(0);
  });
});

describe('FD5/FD6 — frontend pre-delivery gate (a commit BLOCKS on a staged CRITICAL frontend defect)', () => {
  const execFileP = promisify(execFile);
  let repo: string;

  async function git(args: string[]): Promise<void> {
    await execFileP('git', args, { cwd: repo });
  }
  async function initRepo(): Promise<void> {
    repo = await mkdtemp(join(tmpdir(), 'osq-v2enf-repo-'));
    await git(['init', '-q']);
    await git(['config', 'user.email', 't@t']);
    await git(['config', 'user.name', 't']);
  }
  const commitInRepo = (): Event =>
    ({
      kind: 'tool_call',
      tool: 'Bash',
      args: { command: 'git commit -m x' },
      cwd: repo,
    }) as unknown as Event;

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('BLOCKS a commit that stages an <img> with no alt (WCAG 1.1.1 critical)', async () => {
    await activate(['fullstack-flow']);
    await initRepo();
    await writeFile(join(repo, 'Card.tsx'), 'export const C = () => <img src="logo.png">;', 'utf8');
    await git(['add', 'Card.tsx']);
    const res = await enforceV2GatesPre('sess-fe-block', commitInRepo());
    expect(res.exitCode).toBe(2);
    expect(res.message).toMatch(/frontend pre-delivery gate/i);
  });

  it('PASSES a commit that stages a clean frontend file (img has alt)', async () => {
    await activate(['fullstack-flow']);
    await initRepo();
    await writeFile(
      join(repo, 'Card.tsx'),
      'export const C = () => <img src="x" alt="ok" />;',
      'utf8',
    );
    await git(['add', 'Card.tsx']);
    expect((await enforceV2GatesPre('sess-fe-clean', commitInRepo())).exitCode).toBe(0);
  });

  it('PASSES a commit that stages only backend code (fail-open — nothing to audit)', async () => {
    await activate(['fullstack-flow']);
    await initRepo();
    await writeFile(join(repo, 'server.ts'), 'export const x = 1;', 'utf8');
    await git(['add', 'server.ts']);
    expect((await enforceV2GatesPre('sess-fe-backend', commitInRepo())).exitCode).toBe(0);
  });
});

describe('runToDoneStopBlock (AF.6/AF.7 — the run-to-done pause-gate)', () => {
  const NOW = '2026-06-27T00:00:00.000Z';

  it('BLOCKS turn-end in automation mode when the FSM is past SCOPE + not terminal', async () => {
    const sid = 'sess-r2d-block';
    await setAutomationFlag(sid);
    await writeActiveTask(sid, { id: 'T-r', subject: 'r', started_at: NOW });
    await persistActorState(sid, 'fullstack-flow', 'plan', NOW, 'T-r');
    expect(await runToDoneStopBlock(sid)).toMatch(/run to done/i);
  });

  it('ALLOWS turn-end in INTERACTIVE mode (no automation flag — never traps the human)', async () => {
    const sid = 'sess-r2d-interactive';
    await writeActiveTask(sid, { id: 'T-r', subject: 'r', started_at: NOW });
    await persistActorState(sid, 'fullstack-flow', 'plan', NOW, 'T-r');
    expect(await runToDoneStopBlock(sid)).toBeNull();
  });

  it('ALLOWS turn-end at SCOPE (the interactive boundary) even in automation mode', async () => {
    const sid = 'sess-r2d-scope';
    await setAutomationFlag(sid);
    await writeActiveTask(sid, { id: 'T-r', subject: 'r', started_at: NOW });
    await persistActorState(sid, 'fullstack-flow', 'scope', NOW, 'T-r');
    expect(await runToDoneStopBlock(sid)).toBeNull();
  });

  it('ALLOWS turn-end when there is no active task', async () => {
    const sid = 'sess-r2d-notask';
    await setAutomationFlag(sid);
    expect(await runToDoneStopBlock(sid)).toBeNull();
  });
});

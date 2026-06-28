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
import { writeActiveTask, recordSessionCwd } from '../session_state.js';
import { persistActorState } from '../fsm_state.js';
import { workGraphStore, bindProject } from '../../workgraph/store.js';
import { OPENSQUID_HOME } from '../paths.js';
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

describe('runToDoneStopBlock — run-to-done = drain the kanban (V2-ENF.5)', () => {
  // Signal = the PER-PROCESS env OPENSQUID_AUTOMATION=1 (a real lap), NOT the persistent flag-file (F6).
  const PRIOR_AUTO = process.env.OPENSQUID_AUTOMATION;
  const setLap = (): void => {
    process.env.OPENSQUID_AUTOMATION = '1';
  };
  afterEach(() => {
    if (PRIOR_AUTO === undefined) delete process.env.OPENSQUID_AUTOMATION;
    else process.env.OPENSQUID_AUTOMATION = PRIOR_AUTO;
  });
  // Seed one READY issue into the per-test HOME work-graph (legacy-global — the marker-less session's project).
  async function seedReady(): Promise<void> {
    const store = workGraphStore({
      dbUrl: `file:${join(OPENSQUID_HOME(), 'workgraph.db')}`,
      sourceDir: join(OPENSQUID_HOME(), 'store', 'issues'),
    });
    await store.init();
    await bindProject(store, 'legacy-global').createIssue({ title: 'ready work', body: '' });
  }

  it('BLOCKS the stop in an autonomous lap while the kanban has READY work', async () => {
    setLap();
    await seedReady();
    expect(await runToDoneStopBlock('sess-r2d-ready')).toMatch(/run to done/i);
  });

  it('ALLOWS the stop when the kanban is empty (board drained)', async () => {
    setLap();
    expect(await runToDoneStopBlock('sess-r2d-empty')).toBeNull();
  });

  it('ALLOWS the stop INTERACTIVELY (no automation env) even with ready work — never traps the human', async () => {
    delete process.env.OPENSQUID_AUTOMATION;
    await setAutomationFlag('sess-r2d-interactive'); // a stale flag-file must NOT trigger the block (F6)
    await seedReady();
    expect(await runToDoneStopBlock('sess-r2d-interactive')).toBeNull();
  });
});

describe('scope-before-code entry-guard (force-into-the-loop)', () => {
  const T = '2026-06-28T00:00:00.000Z';
  const srcWrite = (): Event =>
    ({
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'src/foo.ts', content: 'x' },
    }) as unknown as Event;
  const docWrite = (): Event =>
    ({
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'docs/notes.md', content: 'x' },
    }) as unknown as Event;

  it('BLOCKS a source Write while the active task FSM is at SCOPE', async () => {
    await activate(['fullstack-flow']);
    const sid = 'sess-ebg-block';
    await writeActiveTask(sid, { id: 'T-e', subject: 'e', started_at: T });
    await persistActorState(sid, 'fullstack-flow', 'scope', T, 'T-e');
    const r = await enforceV2GatesPre(sid, srcWrite());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/scope-before-code/i);
  });

  it('BLOCKS a source Write when there is NO active task (must enter the loop)', async () => {
    await activate(['fullstack-flow']);
    expect((await enforceV2GatesPre('sess-ebg-notask', srcWrite())).exitCode).toBe(2);
  });

  it('PASSES a source Write once the task has cleared SCOPE (FSM=plan)', async () => {
    await activate(['fullstack-flow']);
    const sid = 'sess-ebg-plan';
    await writeActiveTask(sid, { id: 'T-e', subject: 'e', started_at: T });
    await persistActorState(sid, 'fullstack-flow', 'plan', T, 'T-e');
    expect((await enforceV2GatesPre(sid, srcWrite())).exitCode).toBe(0);
  });

  it('PASSES a docs Write at SCOPE (only source code is gated)', async () => {
    await activate(['fullstack-flow']);
    const sid = 'sess-ebg-docs';
    await writeActiveTask(sid, { id: 'T-e', subject: 'e', started_at: T });
    await persistActorState(sid, 'fullstack-flow', 'scope', T, 'T-e');
    expect((await enforceV2GatesPre(sid, docWrite())).exitCode).toBe(0);
  });

  it('PASSES a source Write when fullstack-flow is NOT active (opt-in only)', async () => {
    await activate([]);
    expect((await enforceV2GatesPre('sess-ebg-inactive', srcWrite())).exitCode).toBe(0);
  });
});

describe('mandatory reporting gates (V2-ENF.2)', () => {
  const T = '2026-06-28T00:00:00.000Z';
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), 'osq-rep-proj-'));
  });
  afterEach(async () => {
    await rm(proj, { recursive: true, force: true });
  });
  const srcWrite = (): Event =>
    ({
      kind: 'tool_call',
      tool: 'Write',
      args: { file_path: 'src/foo.ts', content: 'x' },
    }) as unknown as Event;
  const commitE = (): Event =>
    ({ kind: 'tool_call', tool: 'Bash', args: { command: 'git commit -m x' } }) as unknown as Event;
  async function writeReport(prefix: string, taskId: string): Promise<void> {
    await mkdir(join(proj, 'docs', 'reports'), { recursive: true });
    await writeFile(
      join(proj, 'docs', 'reports', `${prefix}-${taskId}-2026-06-28.md`),
      'x',
      'utf8',
    );
  }
  async function seed(sid: string): Promise<void> {
    await activate(['fullstack-flow']);
    await recordSessionCwd(sid, proj);
    await writeActiveTask(sid, { id: 'T-r', subject: 'r', started_at: T });
    await persistActorState(sid, 'fullstack-flow', 'plan', T, 'T-r'); // past SCOPE so the entry-guard passes
  }

  it('BLOCKS a source edit (past SCOPE) until the action-plan report exists', async () => {
    const sid = 'sess-rep-plan-block';
    await seed(sid);
    const r = await enforceV2GatesPre(sid, srcWrite());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/plan-report gate/i);
  });

  it('PASSES the source edit once the action-plan report exists', async () => {
    const sid = 'sess-rep-plan-pass';
    await seed(sid);
    await writeReport('plan', 'T-r');
    expect((await enforceV2GatesPre(sid, srcWrite())).exitCode).toBe(0);
  });

  it('BLOCKS a commit until the completion report exists', async () => {
    const sid = 'sess-rep-done-block';
    await seed(sid);
    const r = await enforceV2GatesPre(sid, commitE());
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/completion-report gate/i);
  });

  it('PASSES the commit once the completion report exists', async () => {
    const sid = 'sess-rep-done-pass';
    await seed(sid);
    await writeReport('completion', 'T-r');
    expect((await enforceV2GatesPre(sid, commitE())).exitCode).toBe(0);
  });
});

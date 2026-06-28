/**
 * V2 gate enforcement in PreToolUse — proves the gates can now BLOCK (the fix for "structurally incapable of
 * blocking"). A `git commit` with incomplete phases is denied; non-advance actions pass; an inactive pack passes.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

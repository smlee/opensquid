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
  // The real CODE-gate BLOCK (active task + incomplete phases) is proven live in the repo where buildGuardCtx
  // can build its CodeIndex; here we cover the over-strict FIX + the action classification deterministically.
  it('PASSES a git commit when there is NO active task (mirrors v1 — ad-hoc commits not blocked)', async () => {
    await activate(['fullstack-flow']); // active pack, but no active task
    const r = await enforceV2GatesPre('sess-enf-noactive', commit());
    expect(r.exitCode).toBe(0);
  });

  it('PASSES a non-advance action (ls) without evaluating any gate', async () => {
    await activate(['fullstack-flow']);
    const r = await enforceV2GatesPre('sess-enf-pass', benign());
    expect(r.exitCode).toBe(0);
  });

  it('PASSES when fullstack-flow is NOT active (no gate to enforce)', async () => {
    await activate([]); // no v2 cartridge
    const r = await enforceV2GatesPre('sess-enf-inactive', commit());
    expect(r.exitCode).toBe(0);
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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPack } from '../packs/loader.js';
import type { Event } from '../runtime/event.js';
import { readFsmState } from '../runtime/fsm_state.js';
import { writeRequestType } from '../runtime/session_state.js';

import { registerArmScopeFunction } from './arm_scope.js';
import { FunctionRegistry } from './registry.js';
import type { EvalCtx } from './registry.js';

const SID = 'arm-scope-test';
let home: string;
let fsm: EvalCtx['packFsm'];
const savedHome = process.env.OPENSQUID_HOME;

const rec = (type: 'research' | 'work') => ({
  type,
  confidence: 'high' as const,
  source: 'deterministic' as const,
  prompt_hash: 'x',
  at: '2026-06-14T00:00:00.000Z',
});
const toolCall: Event = { kind: 'tool_call', tool: 'Bash', args: { command: 'x' }, cwd: '/x' };

async function callArm(packFsm: EvalCtx['packFsm']): Promise<unknown> {
  const reg = new FunctionRegistry();
  registerArmScopeFunction(reg);
  const def = reg.get('arm_scope');
  if (def === undefined) throw new Error('arm_scope not registered');
  const ctx: EvalCtx = {
    event: toolCall,
    bindings: new Map(),
    sessionId: SID,
    packId: 'coding-flow',
    // exactOptionalPropertyTypes: omit packFsm entirely for the no-FSM case (can't assign undefined).
    ...(packFsm !== undefined ? { packFsm } : {}),
  };
  const r = await def.execute({}, ctx);
  expect(r.ok).toBe(true);
  return r.ok ? r.value : undefined;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'opensquid-armscope-'));
  process.env.OPENSQUID_HOME = home;
  fsm = (await loadPack(resolve('packs/builtin', 'coding-flow'))).fsm;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

describe('arm_scope primitive (wg-649d80e78e64 — the single research-veto chokepoint)', () => {
  it('research-classified turn → VETO (FSM stays idle, no scope_start)', async () => {
    await writeRequestType(SID, rec('research'));
    const next = await callArm(fsm);
    expect(next).toBe('idle');
    expect(await readFsmState(SID, 'coding-flow', fsm!)).toBe('idle');
  });

  it('work-classified turn → arms (scope_start → scoping)', async () => {
    await writeRequestType(SID, rec('work'));
    const next = await callArm(fsm);
    expect(next).toBe('scoping');
    expect(await readFsmState(SID, 'coding-flow', fsm!)).toBe('scoping');
  });

  it('absent request-type record → arms (backward-compat, null-safe)', async () => {
    const next = await callArm(fsm);
    expect(next).toBe('scoping');
  });

  it('no pack FSM → ok(null) no-op', async () => {
    const next = await callArm(undefined);
    expect(next).toBeNull();
  });
});

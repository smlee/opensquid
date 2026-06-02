/**
 * T-PACK-FSM-STANDARDIZATION slice C — END-TO-END proof of FSM-driven
 * guess-prevention through the real dispatcher.
 *
 * This is the payoff of the A-stack: a pack declares a scope-lifecycle FSM
 * (A2), the dispatcher threads it (A3b), and the pack's OWN rules drive +
 * gate on it (read_fsm_state / advance_fsm) to ENFORCE "research before code":
 *
 *   - Writing to `src/` while the FSM is in `scoping` → BLOCK (exit 2).
 *   - Writing the pre-research artifact `advance_fsm`s the lifecycle to
 *     `researched` (no block).
 *   - Writing to `src/` once `researched` → ALLOWED (exit 0).
 *
 * Unlike today's existence-based scope gate (does a pre-research FILE exist?),
 * this is STATE-driven: guess-freeness becomes a checkable FSM invariant, and
 * the machine can LOOP BACK (researching --guess_found--> researching) — the
 * edge the old chain_state cannot express. The loop-back mechanics are unit-
 * tested in fsm/fsm_state/functions; here we prove the dispatcher path.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerEventFunctions } from '../../functions/event.js';
import { registerFsmFunctions } from '../../functions/fsm.js';
import { FunctionRegistry } from '../../functions/registry.js';
import { registerVerdictFunctions } from '../../functions/verdict.js';
import type { Fsm } from '../fsm.js';
import type { Pack, Rule, ToolCallEvent } from '../types.js';

import { dispatchEvent } from './dispatch.js';

const SCOPE_FSM: Fsm = {
  initial: 'scoping',
  states: ['scoping', 'researching', 'researched', 'building'],
  transitions: [
    { from: 'scoping', on: 'research_done', to: 'researched' },
    { from: 'researching', on: 'research_done', to: 'researched' },
    // loop-back: an unresolved guess keeps the machine in researching.
    { from: 'researching', on: 'guess_found', to: 'researching' },
    { from: 'researched', on: 'build', to: 'building' },
  ],
};

const advanceRule: Rule = {
  id: 'advance-on-research-doc',
  kind: 'track_check',
  requires: [],
  process: [
    { call: 'tool_name', as: 'tool' },
    { call: 'tool_args', as: 'targs' },
    {
      call: 'advance_fsm',
      if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "docs/research/")',
      args: { event: 'research_done' },
    },
  ],
};

const gateRule: Rule = {
  id: 'research-before-code',
  kind: 'track_check',
  requires: [],
  process: [
    { call: 'tool_name', as: 'tool' },
    { call: 'tool_args', as: 'targs' },
    { call: 'read_fsm_state', as: 'st' },
    {
      call: 'verdict',
      if: '(tool == "Write" || tool == "Edit") && contains(targs.file_path, "src/") && st != "researched" && st != "building"',
      args: { level: 'block', message: 'BLOCKED: research before code — finish scoping first.' },
    },
  ],
};

function scopePack(): Pack {
  return {
    name: 'scope-fsm',
    version: '0.0.0',
    scope: 'workflow',
    goal: 'enforce research-before-code via a lifecycle FSM',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [
      {
        name: 'scope-fsm-skill',
        load: 'preload',
        when_to_load: [],
        requires: [],
        unloads_when: [],
        triggers: [{ kind: 'tool_call' }],
        rules: [advanceRule, gateRule],
      },
    ],
    activationScope: 'project',
    detectedBy: [],
    fsm: SCOPE_FSM,
  };
}

function registry(): FunctionRegistry {
  const r = new FunctionRegistry();
  registerEventFunctions(r);
  registerFsmFunctions(r);
  registerVerdictFunctions(r);
  return r;
}

const writeCode: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'src/feature.ts' },
};
const writeResearch: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/research/feature-pre-research.md' },
};

describe('scope guess-FSM — end-to-end through the dispatcher', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-scope-fsm-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('BLOCKS a src/ write while the FSM is still in scoping', async () => {
    const result = await dispatchEvent(writeCode, [scopePack()], registry(), 'sess-scope-1');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/research before code/);
  });

  it('advances on the pre-research write, then ALLOWS the src/ write', async () => {
    const reg = registry();
    const pack = scopePack();
    const sid = 'sess-scope-2';
    // 1. blocked while scoping
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(2);
    // 2. writing the pre-research artifact advances the lifecycle (no block)
    expect((await dispatchEvent(writeResearch, [pack], reg, sid)).exitCode).toBe(0);
    // 3. now researched → the same src/ write is allowed
    expect((await dispatchEvent(writeCode, [pack], reg, sid)).exitCode).toBe(0);
  });

  it('state is per-session: a fresh session is back in scoping (still blocked)', async () => {
    const reg = registry();
    const pack = scopePack();
    await dispatchEvent(writeResearch, [pack], reg, 'sess-scope-3a'); // advance session 3a
    // a DIFFERENT session has its own machine, still in scoping → blocked
    expect((await dispatchEvent(writeCode, [pack], reg, 'sess-scope-3b')).exitCode).toBe(2);
  });
});

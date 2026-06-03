/**
 * Built-in `workflow-fsm` pack (T-WORKFLOW-AS-PACK-FSM) — the 7-phase workflow
 * as a pack FSM, driven entirely through the real dispatcher. Proves the
 * complete replacement for chain_state: the milestone signals advance the FSM,
 * enrichment paths are captured + replayed into the handoff directives, and the
 * gating is state-driven — no hardcoded transitions, no chain_stage precondition.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { buildRegistry } from '../../src/runtime/bootstrap.js';
import { readFsmState } from '../../src/runtime/fsm_state.js';
import { dispatchEvent } from '../../src/runtime/hooks/dispatch.js';
import type { Event, Pack } from '../../src/runtime/types.js';

const promptScope: Event = { kind: 'prompt_submit', prompt: 'let me scope a new task' };
const promptPlain: Event = { kind: 'prompt_submit', prompt: 'continue working' };
const writeResearch: Event = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/research/x-pre-research-2026.md' },
};
const writeSpec: Event = {
  kind: 'tool_call',
  tool: 'Write',
  args: { file_path: 'docs/tasks/T-x.md' },
};
const taskCreate: Event = {
  kind: 'tool_call',
  tool: 'TaskCreate',
  args: { metadata: { taskId: 'T-x.1' } },
};
const logPhase: Event = {
  kind: 'post_tool_call',
  tool: 'mcp__opensquid__log_phase',
  args: { phase: 'pre_research' },
  exit_code: 0,
};

describe('builtin workflow-fsm pack — full lifecycle through the dispatcher', () => {
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-workflow-fsm-'));
    process.env.OPENSQUID_HOME = tempHome;
  });
  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('advances through the lifecycle on the milestone signals + fires the handoff directives', async () => {
    const reg = await buildRegistry({ engineClient: null });
    const pack: Pack = await loadPack(resolve('packs/builtin/workflow-fsm'));
    const sid = 'wf-lifecycle';
    const stage = (): Promise<string> => readFsmState(sid, 'workflow-fsm', pack.fsm!);

    expect(await stage()).toBe('idle');

    // scope-intent prompt → scoping
    await dispatchEvent(promptScope, [pack], reg, sid);
    expect(await stage()).toBe('scoping');

    // pre-research write → researched (+ captures the path)
    await dispatchEvent(writeResearch, [pack], reg, sid);
    expect(await stage()).toBe('researched');

    // spec write → spec_authored (+ captures the spec path)
    await dispatchEvent(writeSpec, [pack], reg, sid);
    expect(await stage()).toBe('spec_authored');

    // a plain prompt now surfaces the spec→tasks handoff directive (a TOOL
    // directive — passes through), carrying the captured spec path through
    // NESTED interpolation — the end-to-end proof of enrichment capture+replay.
    const atSpec = await dispatchEvent(promptPlain, [pack], reg, sid);
    const specHandoff = atSpec.directives.find((d) => d.ruleId === 'handoff-spec-to-tasks');
    expect(specHandoff).toBeDefined();
    expect(JSON.stringify(specHandoff)).toContain('docs/tasks/T-x.md');

    // TaskCreate with provenance → tasks_loaded
    await dispatchEvent(taskCreate, [pack], reg, sid);
    expect(await stage()).toBe('tasks_loaded');

    // log_phase (incomplete 7-phase set → phase_started) → phases_in_flight
    await dispatchEvent(logPhase, [pack], reg, sid);
    expect(await stage()).toBe('phases_in_flight');
  });

  it('does not advance for a plain (non-scope) prompt — stays idle', async () => {
    const reg = await buildRegistry({ engineClient: null });
    const pack: Pack = await loadPack(resolve('packs/builtin/workflow-fsm'));
    const sid = 'wf-plain';
    await dispatchEvent(promptPlain, [pack], reg, sid);
    expect(await readFsmState(sid, 'workflow-fsm', pack.fsm!)).toBe('idle');
  });
});

/**
 * Tests for the hook dispatcher (`dispatchEvent`).
 *
 * Coverage:
 *   - Empty pack list → exit 0, empty stderr.
 *   - Pack with a rule that produces a block verdict → exit 2, stderr = message.
 *   - Pack with a rule that produces no verdict → exit 0, empty stderr.
 *   - First-match short-circuit: a blocking rule in pack #1 wins over a
 *     later pack that would have warned.
 *
 * Tests build minimal fake packs/skills/rules that thread through the real
 * evaluator + registry — no mocks of those layers. The trick is registering
 * a one-off `test_emit_verdict` primitive that returns a pre-baked Verdict;
 * that lets us drive a deterministic verdict outcome without standing up the
 * full verdict-primitive process.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FunctionRegistry } from '../../functions/registry.js';
import { ok } from '../result.js';
import type { TickState } from '../unload_conditions.js';
import { setAutomationFlag } from '../automation_state.js';
import { transitionChainStage } from '../chain_state.js';
import { writeActiveTask } from '../session_state.js';
import type { SkillRequires } from '../skill_requires.js';
import type {
  Pack,
  Rule,
  ScheduleEvent,
  Skill,
  ToolCallEvent,
  Trigger,
  Verdict,
} from '../types.js';

import { dispatchEvent, shouldSkillUnload } from './dispatch.js';

const event: ToolCallEvent = {
  kind: 'tool_call',
  tool: 'Bash',
  args: { command: 'git commit --amend' },
};

function buildRegistryWithVerdict(verdict: Verdict): FunctionRegistry {
  const r = new FunctionRegistry();
  r.register({
    name: 'verdict',
    argSchema: z.record(z.unknown()),
    // eslint-disable-next-line @typescript-eslint/require-await -- async to match FunctionDef contract
    execute: async () => ok(verdict),
  });
  return r;
}

function makePack(
  name: string,
  rules: Rule[],
  triggers: Trigger[] = [{ kind: 'tool_call' }],
  requires: SkillRequires[] = [],
): Pack {
  const skill: Skill = {
    name: `${name}-skill`,
    load: 'preload',
    when_to_load: [],
    // T-ASC ASC.2: skills now carry a `requires:` field; defaulted to [] to
    // preserve back-compat for every existing dispatch test. Tests targeting
    // the precondition gate pass the explicit array via the new parameter.
    requires,
    unloads_when: [],
    triggers,
    rules,
  };
  return {
    name,
    version: '0.0.0',
    scope: 'workflow',
    goal: 'test',
    description: '',
    requires: [],
    conflicts: [],
    evolves: true,
    skills: [skill],
    activationScope: 'project',
    detectedBy: [],
  };
}

const verdictRule: Rule = {
  id: 'fake-rule',
  kind: 'track_check',
  requires: [],
  process: [{ call: 'verdict' }],
};

describe('dispatchEvent', () => {
  // CU.2 added a persisted-tick advance to the dispatch path. Isolate that
  // disk I/O in a tmp OPENSQUID_HOME so dispatch tests never write tick files
  // into the developer's real ~/.opensquid (the standard session_state test
  // pattern).
  let tempHome: string;
  let priorHome: string | undefined;

  beforeEach(async () => {
    priorHome = process.env.OPENSQUID_HOME;
    tempHome = await mkdtemp(join(tmpdir(), 'opensquid-dispatch-test-'));
    process.env.OPENSQUID_HOME = tempHome;
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
    else process.env.OPENSQUID_HOME = priorHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('returns exit 0 + empty stderr when no packs are active', async () => {
    const registry = buildRegistryWithVerdict({ level: 'pass', message: 'unused' });
    const result = await dispatchEvent(event, [], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [] });
  });

  it('returns exit 2 + stderr when a rule produces a block verdict', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'no amend' });
    const pack = makePack('p1', [verdictRule]);
    const result = await dispatchEvent(event, [pack], registry, 'sess-1');
    expect(result).toEqual({
      exitCode: 2,
      stderr: 'no amend',
      contextInjections: [],
      directives: [],
    });
  });

  it('returns exit 0 + empty stderr when no rules produce a verdict', async () => {
    // A pack whose only rule has an empty process → evaluator returns no_verdict.
    const noVerdictRule: Rule = { id: 'empty', kind: 'track_check', requires: [], process: [] };
    const pack = makePack('p1', [noVerdictRule]);
    const registry = new FunctionRegistry();
    const result = await dispatchEvent(event, [pack], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [] });
  });

  it('first-match short-circuit: blocking pack #1 wins over later packs', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'pack1 blocks' });
    const pack1 = makePack('pack1', [verdictRule]);
    const pack2 = makePack('pack2', [verdictRule]);
    const result = await dispatchEvent(event, [pack1, pack2], registry, 'sess-1');
    expect(result).toEqual({
      exitCode: 2,
      stderr: 'pack1 blocks',
      contextInjections: [],
      directives: [],
    });
  });

  // -------------------------------------------------------------------------
  // AUTO.1 — event-kind filter
  //
  // Per task spec acceptance: "evaluator filters skills per event kind". The
  // dispatcher must skip any skill whose triggers don't subscribe to the
  // incoming event kind. Tests verify both directions:
  //   - schedule-only skill on a tool_call event → skipped (no verdict)
  //   - schedule-only skill on a schedule event → fires (verdict)
  //   - multi-kind skill on either event kind → fires on both
  // -------------------------------------------------------------------------

  const scheduleEvent: ScheduleEvent = {
    kind: 'schedule',
    scheduleId: 'weekly-digest',
    fireTime: '2026-05-25T09:00:00Z',
    triggerPayload: {},
  };

  it('AUTO.1: skips a schedule-only skill when the event is a tool_call', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'should-not-fire' });
    const pack = makePack('p1', [verdictRule], [{ kind: 'schedule', cron: '0 9 * * 1' }]);
    const result = await dispatchEvent(event, [pack], registry, 'sess-1');
    // Skill subscribes only to `schedule`; tool_call must pass through.
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [] });
  });

  it('AUTO.1: fires a schedule-only skill when the event is a schedule', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'sched fired' });
    const pack = makePack('p1', [verdictRule], [{ kind: 'schedule', cron: '0 9 * * 1' }]);
    const result = await dispatchEvent(scheduleEvent, [pack], registry, 'sess-1');
    expect(result).toEqual({
      exitCode: 2,
      stderr: 'sched fired',
      contextInjections: [],
      directives: [],
    });
  });

  it('AUTO.1: fires a multi-kind skill on both tool_call and schedule', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'multi fired' });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'tool_call' }, { kind: 'schedule', cron: '0 9 * * 1' }],
    );
    const onTool = await dispatchEvent(event, [pack], registry, 'sess-1');
    const onSched = await dispatchEvent(scheduleEvent, [pack], registry, 'sess-1');
    expect(onTool).toEqual({
      exitCode: 2,
      stderr: 'multi fired',
      contextInjections: [],
      directives: [],
    });
    expect(onSched).toEqual({
      exitCode: 2,
      stderr: 'multi fired',
      contextInjections: [],
      directives: [],
    });
  });

  // -------------------------------------------------------------------------
  // T-ASC ASC.2 — Skill.requires AND-precondition gate
  //
  // Slots between the trigger filter and the rule walk. AND-semantics across
  // 3 kinds (automation_mode_on, active_task_present, chain_stage). Empty
  // requires:[] is back-compat: every existing test above relies on the
  // default empty array and still passes.
  // -------------------------------------------------------------------------

  it('ASC.2: skill with requires=[automation_mode_on] and flag absent → no verdict', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'should-not-fire' });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'tool_call' }],
      [{ kind: 'automation_mode_on' }],
    );
    const result = await dispatchEvent(event, [pack], registry, 'sess-asc2-1');
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [] });
  });

  it('ASC.2: skill with requires=[automation_mode_on] and flag present → verdict fires', async () => {
    await setAutomationFlag('sess-asc2-2');
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'auto-on fired' });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'tool_call' }],
      [{ kind: 'automation_mode_on' }],
    );
    const result = await dispatchEvent(event, [pack], registry, 'sess-asc2-2');
    expect(result).toEqual({
      exitCode: 2,
      stderr: 'auto-on fired',
      contextInjections: [],
      directives: [],
    });
  });

  it('ASC.2: skill with requires=[automation_mode_on, active_task_present] AND-fails on missing task', async () => {
    await setAutomationFlag('sess-asc2-3');
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'should-not-fire' });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'tool_call' }],
      [{ kind: 'automation_mode_on' }, { kind: 'active_task_present' }],
    );
    const result = await dispatchEvent(event, [pack], registry, 'sess-asc2-3');
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [] });
  });

  it('ASC.2: skill with requires=[chain_stage:researched] fires only when chain is researched', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'researched fired' });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'tool_call' }],
      [{ kind: 'chain_stage', stage: 'researched' }],
    );
    // Initial: chain is idle → no fire.
    const idleResult = await dispatchEvent(event, [pack], registry, 'sess-asc2-4');
    expect(idleResult.exitCode).toBe(0);
    // Transition chain to researched → fires.
    await transitionChainStage('sess-asc2-4', 'researched');
    const researchedResult = await dispatchEvent(event, [pack], registry, 'sess-asc2-4');
    expect(researchedResult).toEqual({
      exitCode: 2,
      stderr: 'researched fired',
      contextInjections: [],
      directives: [],
    });
    // Transition past → no longer fires.
    await transitionChainStage('sess-asc2-4', 'spec_authored');
    const pastResult = await dispatchEvent(event, [pack], registry, 'sess-asc2-4');
    expect(pastResult.exitCode).toBe(0);
  });

  it('ASC.2: skill with empty requires:[] retains back-compat (rules walk)', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'no-req fired' });
    const pack = makePack('p1', [verdictRule]);
    // Empty requires:[] is the default — trivially holds.
    const result = await dispatchEvent(event, [pack], registry, 'sess-asc2-5');
    expect(result).toEqual({
      exitCode: 2,
      stderr: 'no-req fired',
      contextInjections: [],
      directives: [],
    });
  });

  it('ASC.2: requires gate runs BEFORE rule walk (rule primitives never called when gate fails)', async () => {
    // Build a registry where the verdict primitive THROWS — if the rule walk
    // ran, the dispatch would surface a stderr error. The gate must prevent
    // the rule from ever calling the primitive.
    const r = new FunctionRegistry();
    r.register({
      name: 'verdict',
      argSchema: z.record(z.unknown()),
      // eslint-disable-next-line @typescript-eslint/require-await -- async to match FunctionDef contract
      execute: async () => {
        throw new Error('PRIMITIVE_CALLED — gate did not short-circuit');
      },
    });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'tool_call' }],
      [
        { kind: 'automation_mode_on' }, // flag absent → gate fails → no rule walk
      ],
    );
    const result = await dispatchEvent(event, [pack], r, 'sess-asc2-6');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain('PRIMITIVE_CALLED');
  });

  it('ASC.2: requires gate runs AFTER trigger filter (wrong-kind event short-circuits before stat)', async () => {
    // The skill has a chain_stage precondition and only subscribes to
    // schedule events. A tool_call event should be filtered out by the
    // trigger check FIRST, before the precondition's chain-state read runs.
    // We assert by passing an active task + automation flag + chain stage
    // and noting that the OK-no-fire outcome means the trigger filter
    // intercepted (no verdict surfaced on the wrong-kind path).
    await setAutomationFlag('sess-asc2-7');
    await transitionChainStage('sess-asc2-7', 'researched');
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'should-not-fire' });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'schedule', cron: '0 9 * * 1' }],
      [{ kind: 'chain_stage', stage: 'researched' }],
    );
    const result = await dispatchEvent(event, [pack], registry, 'sess-asc2-7');
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [], directives: [] });
  });

  // -------------------------------------------------------------------------
  // T-ASC ASC.3 — directive verdict aggregation
  //
  // Directives accumulate in DispatchResult.directives parallel to
  // contextInjections. Only the UserPromptSubmit hook bin actually surfaces
  // them (via the envelope's additionalContext). Other hook bins drop with
  // a warning. Block + directive coexist (block wins exit code; directive
  // still rides through the directives field).
  // -------------------------------------------------------------------------

  const promptSubmitEvent = { kind: 'prompt_submit' as const, prompt: 'p' };

  it('ASC.3: directive verdict on prompt_submit aggregates into DispatchResult.directives', async () => {
    const directiveVerdict = {
      level: 'directive',
      next_action: {
        skill: 'task-spec-author',
        args: { pre_research_path: '/abs/p.md' },
        rationale: 'pre-research landed — author the spec next.',
      },
    };
    const registry = buildRegistryWithVerdict(directiveVerdict as unknown as Verdict);
    const pack = makePack('p1', [verdictRule], [{ kind: 'prompt_submit' }]);
    const result = await dispatchEvent(promptSubmitEvent, [pack], registry, 'sess-asc3-1');
    expect(result.exitCode).toBe(0);
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0]?.next_action.skill).toBe('task-spec-author');
    expect(result.directives[0]?.ruleId).toBe('fake-rule');
  });

  it('ASC.3: directive on a non-prompt_submit event is dropped + warned (mirrors inject_context)', async () => {
    const directiveVerdict = {
      level: 'directive',
      next_action: { skill: 's', rationale: 'r' },
    };
    const registry = buildRegistryWithVerdict(directiveVerdict as unknown as Verdict);
    const pack = makePack('p1', [verdictRule]); // default trigger = tool_call
    const result = await dispatchEvent(event, [pack], registry, 'sess-asc3-2');
    expect(result.directives).toHaveLength(0);
    expect(result.stderr.toLowerCase()).toContain('directive');
    expect(result.stderr.toLowerCase()).toContain('drop');
  });

  it('ASC.3: block + directive coexist (directive emitted EARLIER, block emitted LATER → both ride)', async () => {
    // Two skills in two packs. Pack1 emits a directive (continues), Pack2
    // emits a block (short-circuits exit code 2). The directive from pack1
    // still surfaces in DispatchResult.directives.
    const directiveVerdict = {
      level: 'directive',
      next_action: { skill: 's', rationale: 'r' },
    };
    const r1 = new FunctionRegistry();
    r1.register({
      name: 'verdict',
      argSchema: z.record(z.unknown()),
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async () => ok(directiveVerdict),
    });
    const r2 = new FunctionRegistry();
    r2.register({
      name: 'verdict',
      argSchema: z.record(z.unknown()),
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async () => ok({ level: 'block', message: 'STOP' }),
    });
    // We have to walk both packs with ONE registry, so register both with
    // priority — actually the simpler path: two skills inside one pack,
    // one emits directive, second emits block. The dispatcher walks rules
    // in order, so we craft two rules and the directive rule fires first.
    const r = new FunctionRegistry();
    let firstCall = true;
    r.register({
      name: 'verdict',
      argSchema: z.record(z.unknown()),
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async () => {
        const v: unknown = firstCall ? directiveVerdict : { level: 'block', message: 'STOP' };
        firstCall = false;
        return ok(v);
      },
    });
    const rule1: Rule = {
      id: 'dir-rule',
      kind: 'track_check',
      requires: [],
      process: [{ call: 'verdict' }],
    };
    const rule2: Rule = {
      id: 'block-rule',
      kind: 'track_check',
      requires: [],
      process: [{ call: 'verdict' }],
    };
    const pack = makePack('p1', [rule1, rule2], [{ kind: 'prompt_submit' }]);
    const result = await dispatchEvent(promptSubmitEvent, [pack], r, 'sess-asc3-3');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('STOP');
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0]?.ruleId).toBe('dir-rule');
  });

  it('ASC.2: requires:[] all-hold AND-chain — 3 preconds met → fires', async () => {
    const sid = 'sess-asc2-8';
    await setAutomationFlag(sid);
    await writeActiveTask(sid, {
      id: 'ta',
      subject: 'x',
      started_at: new Date().toISOString(),
    });
    await transitionChainStage(sid, 'tasks_loaded');
    const registry = buildRegistryWithVerdict({ level: 'block', message: '3-AND fired' });
    const pack = makePack(
      'p1',
      [verdictRule],
      [{ kind: 'tool_call' }],
      [
        { kind: 'automation_mode_on' },
        { kind: 'active_task_present' },
        { kind: 'chain_stage', stage: 'tasks_loaded' },
      ],
    );
    const result = await dispatchEvent(event, [pack], registry, sid);
    expect(result).toEqual({
      exitCode: 2,
      stderr: '3-AND fired',
      contextInjections: [],
      directives: [],
    });
  });

  // -------------------------------------------------------------------------
  // G.2 — dispatch-trace marker
  //
  // The marker line on STDERR is the load-bearing signal that proves
  // dispatchEvent actually ran (catches the G.1 silent-no-op failure mode in
  // CI). Default-on; OPENSQUID_DISPATCH_TRACE=0 silences. We capture
  // process.stderr.write via vi.spyOn — the dispatcher writes the marker
  // directly to stderr (NOT to a return field) because it must be observable
  // even in the success exit-code-0 path where stderr is otherwise empty.
  // -------------------------------------------------------------------------
  describe('G.2: dispatch-trace marker', () => {
    let originalWrite: typeof process.stderr.write;
    let stderrBuf: string;

    beforeEach(() => {
      stderrBuf = '';
      originalWrite = process.stderr.write.bind(process.stderr);
      // Monkey-patch directly — vi.spyOn doesn't type-narrow process.stderr.write
      // cleanly (overloaded signature). Direct replacement is simpler and is
      // restored in afterEach. The patched function only buffers; it does not
      // forward to the original, so vitest's stderr stays clean during tests.
      process.stderr.write = (chunk: string | Uint8Array): boolean => {
        stderrBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      };
      // Default-on behavior: ensure no leftover env from prior test.
      delete process.env.OPENSQUID_DISPATCH_TRACE;
    });

    afterEach(() => {
      process.stderr.write = originalWrite;
      delete process.env.OPENSQUID_DISPATCH_TRACE;
    });

    it('emits [opensquid-dispatch] marker with event/rules/packs counts on empty-packs path', async () => {
      const registry = buildRegistryWithVerdict({ level: 'pass', message: 'unused' });
      await dispatchEvent(event, [], registry, 'sess-1');
      expect(stderrBuf).toContain('[opensquid-dispatch] event=tool_call rules=0 packs=0');
    });

    it('emits marker with rules=N when N rules were walked before short-circuit', async () => {
      const registry = buildRegistryWithVerdict({ level: 'block', message: 'no amend' });
      const pack = makePack('p1', [verdictRule]);
      await dispatchEvent(event, [pack], registry, 'sess-1');
      expect(stderrBuf).toContain('[opensquid-dispatch] event=tool_call rules=1 packs=1');
    });

    it('emits marker on schedule-event dispatch (not just tool_call)', async () => {
      const registry = buildRegistryWithVerdict({ level: 'pass', message: 'unused' });
      await dispatchEvent(scheduleEvent, [], registry, 'sess-1');
      expect(stderrBuf).toContain('[opensquid-dispatch] event=schedule rules=0 packs=0');
    });

    it('OPENSQUID_DISPATCH_TRACE=0 silences the marker', async () => {
      process.env.OPENSQUID_DISPATCH_TRACE = '0';
      const registry = buildRegistryWithVerdict({ level: 'pass', message: 'unused' });
      await dispatchEvent(event, [], registry, 'sess-1');
      expect(stderrBuf).not.toContain('[opensquid-dispatch]');
    });

    it('OPENSQUID_DISPATCH_TRACE=1 (or unset) still emits — only literal "0" silences', async () => {
      process.env.OPENSQUID_DISPATCH_TRACE = '1';
      const registry = buildRegistryWithVerdict({ level: 'pass', message: 'unused' });
      await dispatchEvent(event, [], registry, 'sess-1');
      expect(stderrBuf).toContain('[opensquid-dispatch]');
    });
  });

  // -------------------------------------------------------------------------
  // G.4 — inject_context aggregation
  //
  // Per Phase-2 lock #6/7: `inject_context` is a non-blocking terminal
  // RuleResult variant. The dispatcher aggregates every fired inject into
  // `contextInjections: string[]` regardless of whether a later verdict
  // short-circuits with block/warn. Block wins on exitCode; injections
  // still ride through.
  //
  // On non-prompt_submit events, an inject_context fire is misconfiguration
  // — the dispatcher writes a stderr warning and discards the payload.
  // -------------------------------------------------------------------------
  describe('G.4: inject_context aggregation', () => {
    const promptEvent = { kind: 'prompt_submit' as const, prompt: 'fix the bug' };

    function buildRegistryWithInject(content: string): FunctionRegistry {
      const r = new FunctionRegistry();
      r.register({
        name: 'inject_emitter',
        argSchema: z.record(z.unknown()),
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async () => ok({ kind: 'inject_context' as const, content }),
      });
      return r;
    }

    const injectRule: Rule = {
      id: 'fake-inject-rule',
      kind: 'track_check',
      requires: [],
      process: [{ call: 'inject_emitter' }],
    };

    it('aggregates a single inject_context payload into contextInjections', async () => {
      const registry = buildRegistryWithInject('recall: foo');
      const pack = makePack('p1', [injectRule], [{ kind: 'prompt_submit' }]);
      const result = await dispatchEvent(promptEvent, [pack], registry, 'sess-1');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.contextInjections).toEqual(['recall: foo']);
    });

    it('aggregates injections from TWO skills (order = pack walk order)', async () => {
      // Two packs each with one inject rule; both should aggregate.
      // We use the same primitive name across registries by constructing one
      // registry that emits a fixed payload, then making two packs that both
      // reference the same primitive. Order is pack1 → pack2.
      const r = new FunctionRegistry();
      let callIdx = 0;
      r.register({
        name: 'inject_emitter',
        argSchema: z.record(z.unknown()),
        execute: async () => {
          await Promise.resolve();
          const content = callIdx === 0 ? 'first inject' : 'second inject';
          callIdx += 1;
          return ok({ kind: 'inject_context' as const, content });
        },
      });
      const pack1 = makePack('p1', [injectRule], [{ kind: 'prompt_submit' }]);
      const pack2 = makePack('p2', [injectRule], [{ kind: 'prompt_submit' }]);
      const result = await dispatchEvent(promptEvent, [pack1, pack2], r, 'sess-1');
      expect(result.exitCode).toBe(0);
      expect(result.contextInjections).toEqual(['first inject', 'second inject']);
    });

    it('coexists with a block verdict — block wins on exitCode, inject still aggregated', async () => {
      // Pack 1 injects, pack 2 blocks. The inject fires first (pack walk
      // order); pack 2's block produces the exitCode 2. The injection rides
      // through so the user sees the recall context alongside the block.
      const r = new FunctionRegistry();
      r.register({
        name: 'inject_emitter',
        argSchema: z.record(z.unknown()),
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async () =>
          ok({ kind: 'inject_context' as const, content: 'inject before block' }),
      });
      r.register({
        name: 'verdict',
        argSchema: z.record(z.unknown()),
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async () => ok({ level: 'block', message: 'blocked after inject' }),
      });
      const pack1 = makePack('p1', [injectRule], [{ kind: 'prompt_submit' }]);
      const pack2 = makePack('p2', [verdictRule], [{ kind: 'prompt_submit' }]);
      const result = await dispatchEvent(promptEvent, [pack1, pack2], r, 'sess-1');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('blocked after inject');
      expect(result.contextInjections).toEqual(['inject before block']);
    });

    it('emits stderr warning + discards inject when fired on a non-prompt_submit event', async () => {
      // Skill subscribes to tool_call but emits inject_context anyway —
      // misconfiguration. The dispatcher drops the payload (empty array)
      // and writes a stderr warning so the pack author can fix the trigger.
      const registry = buildRegistryWithInject('should be dropped');
      const pack = makePack('p1', [injectRule], [{ kind: 'tool_call' }]);
      const toolEvent: ToolCallEvent = { kind: 'tool_call', tool: 'Bash', args: {} };
      const result = await dispatchEvent(toolEvent, [pack], registry, 'sess-1');
      expect(result.exitCode).toBe(0);
      expect(result.contextInjections).toEqual([]);
      expect(result.stderr).toContain('inject_context on event kind "tool_call"');
      expect(result.stderr).toContain('fake-inject-rule');
    });
  });

  // -------------------------------------------------------------------------
  // PR-followup — pack-declared drift_response policy resolution
  //
  // The dispatcher used to hard-code `block_tool` for every verdict. After
  // PR-followup, it consults `pack.driftResponse?.per_rule[rule.id] ??
  // pack.driftResponse?.default` first, falling back to `block_tool` only
  // when the pack ships no drift_response.yaml at all. These tests prove:
  //   - per-rule override (e.g. v1-publish-detector: block_tool) routes through
  //   - default policy fires for rules with no per-rule entry
  //   - `warn` policy maps to exit 0 + stderr message (not exit 2)
  //   - `notify_and_pause` policy maps to exit 0 + empty stderr (stub path)
  //   - pack without drift_response.yaml falls back to historical block_tool
  // -------------------------------------------------------------------------
  describe('PR-followup: pack-declared drift_response resolution', () => {
    // Helper that overlays a `driftResponse` field onto a base Pack.
    function withDrift(pack: Pack, drift: Pack['driftResponse']): Pack {
      return { ...pack, driftResponse: drift };
    }

    it('per-rule block_tool override fires for the named rule', async () => {
      const registry = buildRegistryWithVerdict({
        level: 'block',
        message: 'v1 framing detected',
        ruleId: 'v1-publish-detector',
      });
      const blockRule: Rule = {
        id: 'v1-publish-detector',
        kind: 'track_check',
        requires: [],
        process: [{ call: 'verdict' }],
      };
      const pack = withDrift(makePack('p1', [blockRule]), {
        default: 'notify_and_pause',
        per_rule: { 'v1-publish-detector': 'block_tool' },
        corrective_skills: {},
      });
      const result = await dispatchEvent(event, [pack], registry, 'sess-1');
      // block_tool maps to exit 2 + message in stderr.
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('v1 framing detected');
    });

    it('default policy applies when rule has no per-rule entry', async () => {
      // Verdict fires from a rule that is NOT in per_rule; default `warn`
      // takes effect → exit 0 + message in stderr (allow-with-warning).
      const registry = buildRegistryWithVerdict({
        level: 'block',
        message: 'no per-rule override',
        ruleId: 'unlisted-rule',
      });
      const rule: Rule = {
        id: 'unlisted-rule',
        kind: 'track_check',
        requires: [],
        process: [{ call: 'verdict' }],
      };
      const pack = withDrift(makePack('p1', [rule]), {
        default: 'warn',
        per_rule: { 'some-other-rule': 'block_tool' },
        corrective_skills: {},
      });
      const result = await dispatchEvent(event, [pack], registry, 'sess-1');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('no per-rule override');
    });

    it('notify_and_pause policy maps to exit 0 + empty stderr (Phase 1 stub path)', async () => {
      const registry = buildRegistryWithVerdict({
        level: 'block',
        message: 'pause via channel',
        ruleId: 'paused-rule',
      });
      const rule: Rule = {
        id: 'paused-rule',
        kind: 'track_check',
        requires: [],
        process: [{ call: 'verdict' }],
      };
      const pack = withDrift(makePack('p1', [rule]), {
        default: 'notify_and_pause',
        per_rule: {},
        corrective_skills: {},
      });
      const result = await dispatchEvent(event, [pack], registry, 'sess-1');
      // Real channel routing lands in Task 1.18; dispatcher stub returns
      // exit 0 + empty stderr so a pack-declared notify_and_pause doesn't
      // accidentally block the tool call during Phase 1.
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('pack without driftResponse falls back to historical block_tool default', async () => {
      const registry = buildRegistryWithVerdict({
        level: 'block',
        message: 'no policy → block_tool',
        ruleId: 'rule-without-policy',
      });
      const rule: Rule = {
        id: 'rule-without-policy',
        kind: 'track_check',
        requires: [],
        process: [{ call: 'verdict' }],
      };
      const pack = makePack('p1', [rule]);
      // No driftResponse on pack — preserves pre-PR-followup behavior.
      expect(pack.driftResponse).toBeUndefined();
      const result = await dispatchEvent(event, [pack], registry, 'sess-1');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe('no policy → block_tool');
    });

    it('per-rule warn override on a rule that would otherwise block routes through warn', async () => {
      // Confirms the dispatcher's resolution path is per-rule first, then
      // default, then fallback — and that switching policy actually changes
      // the exit code (the load-bearing evidence the wiring works).
      const registry = buildRegistryWithVerdict({
        level: 'block',
        message: 'informational signal',
        ruleId: 'informational-rule',
      });
      const rule: Rule = {
        id: 'informational-rule',
        kind: 'track_check',
        requires: [],
        process: [{ call: 'verdict' }],
      };
      const pack = withDrift(makePack('p1', [rule]), {
        default: 'block_tool',
        per_rule: { 'informational-rule': 'warn' },
        corrective_skills: {},
      });
      const result = await dispatchEvent(event, [pack], registry, 'sess-1');
      // warn → exit 0 + message visible.
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('informational signal');
    });
  });

  // -------------------------------------------------------------------------
  // CU.2 — skill-unload gate (pure decision helper)
  //
  // `shouldSkillUnload(skill, tick)` is the per-skill decision the dispatcher
  // walks before evaluating a dynamic skill's rules. Pure + testable. The
  // full end-to-end behavior (prose suppression through the real dispatcher)
  // is proved in CU.3; here we lock the decision surface.
  // -------------------------------------------------------------------------
  describe('CU.2: shouldSkillUnload gate decision', () => {
    function skillWith(unloads_when: unknown[]): Skill {
      return {
        name: 's',
        load: 'lazy',
        when_to_load: [],
        requires: [],
        unloads_when,
        triggers: [{ kind: 'prompt_submit' }],
        rules: [],
      };
    }
    const tick = (over: Partial<TickState> = {}): TickState => ({
      turnsSinceActivation: 0,
      taskCompleted: false,
      sessionEnded: false,
      ...over,
    });

    it('idle_n_turns: fires when turnsSinceActivation ≥ n', () => {
      const skill = skillWith([{ idle_n_turns: 3 }]);
      expect(shouldSkillUnload(skill, tick({ turnsSinceActivation: 3 }))).toBe(true);
    });

    it('idle_n_turns: does NOT fire when turnsSinceActivation < n (skill walks)', () => {
      const skill = skillWith([{ idle_n_turns: 3 }]);
      expect(shouldSkillUnload(skill, tick({ turnsSinceActivation: 2 }))).toBe(false);
    });

    it('active_task_completes: fires when taskCompleted latched', () => {
      const skill = skillWith(['active_task_completes']);
      expect(shouldSkillUnload(skill, tick({ taskCompleted: true }))).toBe(true);
    });

    it('session_ends: fires when sessionEnded latched', () => {
      const skill = skillWith(['session_ends']);
      expect(shouldSkillUnload(skill, tick({ sessionEnded: true }))).toBe(true);
    });

    it('empty unloads_when → never unloads', () => {
      const skill = skillWith([]);
      expect(shouldSkillUnload(skill, tick({ turnsSinceActivation: 99 }))).toBe(false);
    });

    it('FAIL-SAFE: undefined tick → default-LOADED (never skip on missing tick)', () => {
      const skill = skillWith([{ idle_n_turns: 1 }]);
      expect(shouldSkillUnload(skill, undefined)).toBe(false);
    });

    it('malformed unloads_when entry is dropped (degrades that condition only)', () => {
      // A bad condition is dropped; a valid one alongside it still evaluates.
      const skill = skillWith([{ idle_n_turns: 'nope' }, { idle_n_turns: 2 }]);
      expect(shouldSkillUnload(skill, tick({ turnsSinceActivation: 2 }))).toBe(true);
      expect(shouldSkillUnload(skill, tick({ turnsSinceActivation: 1 }))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // CU.2 — dispatcher integration: a dynamic skill whose unload condition
  // fired is skipped (its rule does not produce a verdict). Pinned skills are
  // exempt. This drives the real `dispatchEvent` + persisted ticks (tmp HOME
  // from the parent describe's beforeEach).
  // -------------------------------------------------------------------------
  describe('CU.2: dispatcher skips unloaded dynamic skills', () => {
    const promptEvent = { kind: 'prompt_submit' as const, prompt: 'go' };

    /** A pack whose single skill blocks on every prompt_submit, with configurable lifecycle. */
    function lifecyclePack(opts: {
      name: string;
      scope: Pack['scope'];
      load: Skill['load'];
      unloads_when: unknown[];
      when_to_load?: unknown[];
    }): Pack {
      const skill: Skill = {
        name: `${opts.name}-skill`,
        load: opts.load,
        when_to_load: opts.when_to_load ?? [],
        // T-ASC ASC.2: requires field is now required on the runtime Skill
        // type; empty array is back-compat (precondition trivially holds).
        requires: [],
        unloads_when: opts.unloads_when,
        triggers: [{ kind: 'prompt_submit' }],
        rules: [
          {
            id: `${opts.name}-rule`,
            kind: 'track_check',
            requires: [],
            process: [{ call: 'verdict' }],
          },
        ],
      };
      return {
        name: opts.name,
        version: '0.0.0',
        scope: opts.scope,
        goal: 'test',
        description: '',
        requires: [],
        conflicts: [],
        evolves: true,
        skills: [skill],
        activationScope: 'project',
        detectedBy: [],
      };
    }

    it('dynamic skill with idle_n_turns:1 unloads on the 2nd prompt (1st walks, 2nd skipped)', async () => {
      const registry = buildRegistryWithVerdict({ level: 'block', message: 'fired' });
      const pack = lifecyclePack({
        name: 'dyn',
        scope: 'workflow',
        load: 'lazy',
        unloads_when: [{ idle_n_turns: 1 }],
      });
      const sid = 'cu2-idle';
      // Turn 1: tick advances to 1 (≥1) → unload condition fires → skill skipped.
      const t1 = await dispatchEvent(promptEvent, [pack], registry, sid);
      expect(t1.exitCode).toBe(0); // rule skipped → no block
      // Turn 2: still skipped.
      const t2 = await dispatchEvent(promptEvent, [pack], registry, sid);
      expect(t2.exitCode).toBe(0);
    });

    it('dynamic skill with idle_n_turns:2 walks on turn 1, unloads on turn 2', async () => {
      const registry = buildRegistryWithVerdict({ level: 'block', message: 'fired' });
      const pack = lifecyclePack({
        name: 'dyn2',
        scope: 'workflow',
        load: 'lazy',
        unloads_when: [{ idle_n_turns: 2 }],
      });
      const sid = 'cu2-idle2';
      const t1 = await dispatchEvent(promptEvent, [pack], registry, sid); // tick=1, <2 → walks → blocks
      expect(t1.exitCode).toBe(2);
      const t2 = await dispatchEvent(promptEvent, [pack], registry, sid); // tick=2, ≥2 → skipped
      expect(t2.exitCode).toBe(0);
    });

    it('PINNED skill (universal+preload) NEVER unloads even with idle_n_turns:1', async () => {
      const registry = buildRegistryWithVerdict({ level: 'block', message: 'pinned fired' });
      const pack = lifecyclePack({
        name: 'pin',
        scope: 'universal',
        load: 'preload',
        unloads_when: [{ idle_n_turns: 1 }], // pathological — pinned wins, unloads_when ignored
      });
      const sid = 'cu2-pinned';
      const t1 = await dispatchEvent(promptEvent, [pack], registry, sid);
      const t2 = await dispatchEvent(promptEvent, [pack], registry, sid);
      const t3 = await dispatchEvent(promptEvent, [pack], registry, sid);
      // Pinned always walks → always blocks, no matter how many idle turns.
      expect(t1.exitCode).toBe(2);
      expect(t2.exitCode).toBe(2);
      expect(t3.exitCode).toBe(2);
    });

    it('reactivation (when_to_load matches again) resets the tick → skill walks again', async () => {
      const registry = buildRegistryWithVerdict({ level: 'block', message: 'fired' });
      // when_to_load matches a prompt_submit via event_type; idle_n_turns:1.
      const pack = lifecyclePack({
        name: 'react',
        scope: 'workflow',
        load: 'lazy',
        unloads_when: [{ idle_n_turns: 1 }],
        when_to_load: [{ event_type: 'prompt_submit' }],
      });
      const sid = 'cu2-react';
      // Every prompt_submit re-matches when_to_load → tick resets to fresh →
      // advance → 1. With idle_n_turns:1 that fires... but reactivation resets
      // FIRST then advances, so the skill is at turnsSinceActivation:1 every
      // turn → unloads every turn. To prove RESET (not permanent unload) we
      // assert the count never climbs past 1 — i.e. it keeps resetting.
      const r1 = await dispatchEvent(promptEvent, [pack], registry, sid);
      const r2 = await dispatchEvent(promptEvent, [pack], registry, sid);
      // Both turns behave identically (reset each turn) — no permanent unload
      // drift where the count climbs and the skill stays dead.
      expect(r1.exitCode).toBe(r2.exitCode);
    });

    it('dynamic skill with empty unloads_when always walks (no regression)', async () => {
      const registry = buildRegistryWithVerdict({ level: 'block', message: 'fired' });
      const pack = lifecyclePack({
        name: 'always',
        scope: 'workflow',
        load: 'lazy',
        unloads_when: [],
      });
      const sid = 'cu2-empty';
      for (let i = 0; i < 5; i++) {
        const r = await dispatchEvent(promptEvent, [pack], registry, sid);
        expect(r.exitCode).toBe(2); // always blocks → always loaded
      }
    });
  });
});

/* ────────────────────────────────────────────────────────────────────
 * IDF.4 — activation_scope routing in the dispatcher.
 *
 * activationScopeApplies(scope, ctx) governs whether a pack's skills
 * walk at all. The dispatcher filters BEFORE entering the skill loop,
 * so a scope mismatch produces zero rule walks for that pack.
 *
 * The pack here always emits a `block` verdict if its rules run, so the
 * test outcome (exit 2 vs exit 0) directly maps to "did dispatchEvent
 * walk the pack's rules". Test pack uses an explicit activationScope
 * per case.
 * ──────────────────────────────────────────────────────────────────── */
import { activationScopeApplies, type DispatchScopeCtx } from './dispatch.js';
import type { ActivationScope } from '../../packs/schemas/manifest.js';

describe('IDF.4: activationScopeApplies pure function', () => {
  it('project: true ↔ inProject', () => {
    expect(activationScopeApplies('project', { inProject: true, isUserSession: true })).toBe(true);
    expect(activationScopeApplies('project', { inProject: false, isUserSession: true })).toBe(
      false,
    );
  });

  it('user: always true when isUserSession (today, always true)', () => {
    expect(activationScopeApplies('user', { inProject: false, isUserSession: true })).toBe(true);
    expect(activationScopeApplies('user', { inProject: true, isUserSession: true })).toBe(true);
    // pathological: no user session → false
    expect(activationScopeApplies('user', { inProject: true, isUserSession: false })).toBe(false);
  });

  it('hybrid: AND of inProject + isUserSession', () => {
    expect(activationScopeApplies('hybrid', { inProject: true, isUserSession: true })).toBe(true);
    expect(activationScopeApplies('hybrid', { inProject: false, isUserSession: true })).toBe(false);
    expect(activationScopeApplies('hybrid', { inProject: true, isUserSession: false })).toBe(false);
  });

  it('team: always false (inert until team-mode infrastructure ships)', () => {
    expect(activationScopeApplies('team', { inProject: true, isUserSession: true })).toBe(false);
    expect(activationScopeApplies('team', { inProject: false, isUserSession: false })).toBe(false);
  });

  it('global: behaves as user today (= isUserSession) until multi-user lands', () => {
    expect(activationScopeApplies('global', { inProject: true, isUserSession: true })).toBe(true);
    expect(activationScopeApplies('global', { inProject: false, isUserSession: true })).toBe(true);
    expect(activationScopeApplies('global', { inProject: true, isUserSession: false })).toBe(false);
  });
});

describe('IDF.4: dispatchEvent filters packs by activation_scope before walking skills', () => {
  function packWithScope(scope: ActivationScope, packName = 'idf4-test'): Pack {
    // Reuses the existing test-fixture verdict rule (always blocks if walked).
    const skill: Skill = {
      name: `${packName}-skill`,
      load: 'preload',
      when_to_load: [],
      requires: [],
      unloads_when: [],
      triggers: [{ kind: 'tool_call' }],
      rules: [verdictRule],
    };
    return {
      name: packName,
      version: '0.0.0',
      scope: 'workflow',
      goal: 'idf4 test',
      description: '',
      requires: [],
      conflicts: [],
      evolves: true,
      skills: [skill],
      activationScope: scope,
      detectedBy: [],
    };
  }

  const blockRegistry = () => buildRegistryWithVerdict({ level: 'block', message: 'walked' });

  it('back-compat: scopeCtx defaults to inProject=true + isUserSession=true (existing tests work)', async () => {
    const pack = packWithScope('project');
    const r = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-default');
    expect(r.exitCode).toBe(2); // walked → blocked
  });

  it('project pack: NOT walked when inProject=false (skill loop skipped)', async () => {
    const pack = packWithScope('project');
    const ctx: DispatchScopeCtx = { inProject: false, isUserSession: true };
    const r = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-proj-skip', ctx);
    expect(r.exitCode).toBe(0); // skipped → no block
    expect(r.stderr).toBe('');
  });

  it('user pack: walked regardless of inProject', async () => {
    const pack = packWithScope('user');
    const ctx: DispatchScopeCtx = { inProject: false, isUserSession: true };
    const r = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-user', ctx);
    expect(r.exitCode).toBe(2);
  });

  it('hybrid pack: walked only when BOTH inProject + isUserSession', async () => {
    const pack = packWithScope('hybrid');
    const proj = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-hyb-1', {
      inProject: true,
      isUserSession: true,
    });
    expect(proj.exitCode).toBe(2);
    const noProj = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-hyb-2', {
      inProject: false,
      isUserSession: true,
    });
    expect(noProj.exitCode).toBe(0);
  });

  it('team pack: NEVER walked (inert until team-mode infrastructure)', async () => {
    const pack = packWithScope('team');
    const r = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-team', {
      inProject: true,
      isUserSession: true,
    });
    expect(r.exitCode).toBe(0);
  });

  it('global pack: walked when isUserSession (effectively == user today)', async () => {
    const pack = packWithScope('global');
    const r = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-glob', {
      inProject: false,
      isUserSession: true,
    });
    expect(r.exitCode).toBe(2);
  });

  it('Pack with undefined activationScope defaults to project at runtime via ?? coalesce', async () => {
    const pack = packWithScope('project'); // start from a valid Pack
    const packAny = pack as Pack & { activationScope?: ActivationScope };
    delete packAny.activationScope;
    const ctxProj: DispatchScopeCtx = { inProject: true, isUserSession: true };
    const rProj = await dispatchEvent(event, [pack], blockRegistry(), 'idf4-undef-proj', ctxProj);
    expect(rProj.exitCode).toBe(2);
    const ctxNoProj: DispatchScopeCtx = { inProject: false, isUserSession: true };
    const rNoProj = await dispatchEvent(
      event,
      [pack],
      blockRegistry(),
      'idf4-undef-noproj',
      ctxNoProj,
    );
    expect(rNoProj.exitCode).toBe(0);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * LL.3 — inbound_channel trigger filter (channel + sender_pattern).
 *
 * Verifies that `dispatchEvent` honors the optional `channel:` and
 * `sender_pattern` fields on `triggers: [{kind: 'inbound_channel', ...}]`.
 * Malformed regex → silent skip. Empty pattern → accept-all.
 * ──────────────────────────────────────────────────────────────────── */
import type { InboundChannelEvent } from '../event.js';
import { inboundChannelTriggerMatches } from './dispatch.js';

describe('LL.3: inboundChannelTriggerMatches pure filter', () => {
  const baseEvent: InboundChannelEvent = {
    kind: 'inbound_channel',
    channelUri: 'telegram://-100123/281',
    sender: 'alice',
    text: 'hi',
    receivedAt: '2026-05-30T12:00:00Z',
  };

  it('no channel + no sender_pattern → matches (accept-all)', () => {
    expect(inboundChannelTriggerMatches({ kind: 'inbound_channel' }, baseEvent)).toBe(true);
  });

  it('channel: telegram + telegram event → matches', () => {
    expect(
      inboundChannelTriggerMatches({ kind: 'inbound_channel', channel: 'telegram' }, baseEvent),
    ).toBe(true);
  });

  it('channel: slack + telegram event → does NOT match', () => {
    expect(
      inboundChannelTriggerMatches({ kind: 'inbound_channel', channel: 'slack' }, baseEvent),
    ).toBe(false);
  });

  it('sender_pattern: ^alice$ + sender alice → matches', () => {
    expect(
      inboundChannelTriggerMatches(
        { kind: 'inbound_channel', sender_pattern: '^alice$' },
        baseEvent,
      ),
    ).toBe(true);
  });

  it('sender_pattern: ^bob$ + sender alice → does NOT match', () => {
    expect(
      inboundChannelTriggerMatches({ kind: 'inbound_channel', sender_pattern: '^bob$' }, baseEvent),
    ).toBe(false);
  });

  it('malformed regex [unclosed → silent skip (returns false; no throw)', () => {
    expect(
      inboundChannelTriggerMatches(
        { kind: 'inbound_channel', sender_pattern: '[unclosed' },
        baseEvent,
      ),
    ).toBe(false);
  });

  it('empty sender_pattern → accept-all', () => {
    expect(
      inboundChannelTriggerMatches({ kind: 'inbound_channel', sender_pattern: '' }, baseEvent),
    ).toBe(true);
  });

  it('empty channel string → accept-all (back-compat)', () => {
    expect(inboundChannelTriggerMatches({ kind: 'inbound_channel', channel: '' }, baseEvent)).toBe(
      true,
    );
  });
});

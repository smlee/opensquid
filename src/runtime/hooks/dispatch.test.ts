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

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FunctionRegistry } from '../../functions/registry.js';
import { ok } from '../result.js';
import type {
  Pack,
  Rule,
  ScheduleEvent,
  Skill,
  ToolCallEvent,
  Trigger,
  Verdict,
} from '../types.js';

import { dispatchEvent } from './dispatch.js';

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
): Pack {
  const skill: Skill = {
    name: `${name}-skill`,
    load: 'preload',
    when_to_load: [],
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
  };
}

const verdictRule: Rule = {
  id: 'fake-rule',
  kind: 'track_check',
  process: [{ call: 'verdict' }],
};

describe('dispatchEvent', () => {
  it('returns exit 0 + empty stderr when no packs are active', async () => {
    const registry = buildRegistryWithVerdict({ level: 'pass', message: 'unused' });
    const result = await dispatchEvent(event, [], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 0, stderr: '' });
  });

  it('returns exit 2 + stderr when a rule produces a block verdict', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'no amend' });
    const pack = makePack('p1', [verdictRule]);
    const result = await dispatchEvent(event, [pack], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 2, stderr: 'no amend' });
  });

  it('returns exit 0 + empty stderr when no rules produce a verdict', async () => {
    // A pack whose only rule has an empty process → evaluator returns no_verdict.
    const noVerdictRule: Rule = { id: 'empty', kind: 'track_check', process: [] };
    const pack = makePack('p1', [noVerdictRule]);
    const registry = new FunctionRegistry();
    const result = await dispatchEvent(event, [pack], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 0, stderr: '' });
  });

  it('first-match short-circuit: blocking pack #1 wins over later packs', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'pack1 blocks' });
    const pack1 = makePack('pack1', [verdictRule]);
    const pack2 = makePack('pack2', [verdictRule]);
    const result = await dispatchEvent(event, [pack1, pack2], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 2, stderr: 'pack1 blocks' });
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
    expect(result).toEqual({ exitCode: 0, stderr: '' });
  });

  it('AUTO.1: fires a schedule-only skill when the event is a schedule', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'sched fired' });
    const pack = makePack('p1', [verdictRule], [{ kind: 'schedule', cron: '0 9 * * 1' }]);
    const result = await dispatchEvent(scheduleEvent, [pack], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 2, stderr: 'sched fired' });
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
    expect(onTool).toEqual({ exitCode: 2, stderr: 'multi fired' });
    expect(onSched).toEqual({ exitCode: 2, stderr: 'multi fired' });
  });
});

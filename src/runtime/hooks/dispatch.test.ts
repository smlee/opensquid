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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [] });
  });

  it('returns exit 2 + stderr when a rule produces a block verdict', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'no amend' });
    const pack = makePack('p1', [verdictRule]);
    const result = await dispatchEvent(event, [pack], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 2, stderr: 'no amend', contextInjections: [] });
  });

  it('returns exit 0 + empty stderr when no rules produce a verdict', async () => {
    // A pack whose only rule has an empty process → evaluator returns no_verdict.
    const noVerdictRule: Rule = { id: 'empty', kind: 'track_check', process: [] };
    const pack = makePack('p1', [noVerdictRule]);
    const registry = new FunctionRegistry();
    const result = await dispatchEvent(event, [pack], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [] });
  });

  it('first-match short-circuit: blocking pack #1 wins over later packs', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'pack1 blocks' });
    const pack1 = makePack('pack1', [verdictRule]);
    const pack2 = makePack('pack2', [verdictRule]);
    const result = await dispatchEvent(event, [pack1, pack2], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 2, stderr: 'pack1 blocks', contextInjections: [] });
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
    expect(result).toEqual({ exitCode: 0, stderr: '', contextInjections: [] });
  });

  it('AUTO.1: fires a schedule-only skill when the event is a schedule', async () => {
    const registry = buildRegistryWithVerdict({ level: 'block', message: 'sched fired' });
    const pack = makePack('p1', [verdictRule], [{ kind: 'schedule', cron: '0 9 * * 1' }]);
    const result = await dispatchEvent(scheduleEvent, [pack], registry, 'sess-1');
    expect(result).toEqual({ exitCode: 2, stderr: 'sched fired', contextInjections: [] });
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
    expect(onTool).toEqual({ exitCode: 2, stderr: 'multi fired', contextInjections: [] });
    expect(onSched).toEqual({ exitCode: 2, stderr: 'multi fired', contextInjections: [] });
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
});

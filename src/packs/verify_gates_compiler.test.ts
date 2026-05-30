/**
 * DOG.3 — verify_gates_compiler unit tests.
 *
 * Covers: empty input, one-gate compile, multi-gate compile, on_fail
 * level mapping, invalid `check` parse-error surface, trigger
 * deduplication across same-event-kind gates, audit-trail rule id, and
 * the load-time pre-parse loud-failure contract.
 */
import { describe, expect, it } from 'vitest';

import { compileVerifyGates } from './verify_gates_compiler.js';
import type { VerifyGate } from './schemas/manifest.js';

function gate(overrides: Partial<VerifyGate> = {}): VerifyGate {
  return {
    name: 'g1',
    when: { event_kind: 'tool_call' },
    check: 'contains(tool_args.command, "rm -rf")',
    on_fail: { level: 'block', message: 'no rm -rf' },
    ...overrides,
  };
}

describe('DOG.3 — compileVerifyGates', () => {
  it('returns ok with a synthetic skill carrying zero rules + default triggers when gates is empty', () => {
    const r = compileVerifyGates('mypack', []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.name).toBe('mypack/verify');
    expect(r.skill.rules).toEqual([]);
    expect(r.skill.triggers).toEqual([{ kind: 'tool_call' }]);
  });

  it('compiles ONE gate into a single TrackCheckRule whose process gates a verdict on the check expression', () => {
    const r = compileVerifyGates('p', [gate()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.rules).toHaveLength(1);
    const rule = r.skill.rules[0]!;
    expect(rule.id).toBe('gate:g1');
    expect(rule.kind).toBe('track_check');
    if (rule.kind !== 'track_check') return;
    expect(rule.process).toHaveLength(1);
    const step = rule.process[0]!;
    expect(step.call).toBe('verdict');
    expect(step.if).toBe('contains(tool_args.command, "rm -rf")');
    expect(step.args).toEqual({ level: 'block', message: 'no rm -rf' });
  });

  it('propagates on_fail.level: warn through to step.args.level', () => {
    const r = compileVerifyGates('p', [
      gate({ name: 'warn-only', on_fail: { level: 'warn', message: 'heads up' } }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rule = r.skill.rules[0]!;
    if (rule.kind !== 'track_check') return;
    expect(rule.process[0]?.args?.level).toBe('warn');
    expect(rule.process[0]?.args?.message).toBe('heads up');
  });

  it('compiles THREE gates into three rules, audit-trail ids = `gate:<name>`', () => {
    const r = compileVerifyGates('p', [
      gate({ name: 'a' }),
      gate({ name: 'b' }),
      gate({ name: 'c' }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.rules.map((rule) => rule.id)).toEqual(['gate:a', 'gate:b', 'gate:c']);
  });

  it('dedupes triggers when multiple gates share the same event_kind', () => {
    const r = compileVerifyGates('p', [
      gate({ name: 'a', when: { event_kind: 'tool_call' } }),
      gate({ name: 'b', when: { event_kind: 'tool_call' } }),
      gate({ name: 'c', when: { event_kind: 'prompt_submit' } }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.triggers).toHaveLength(2);
    const kinds = r.skill.triggers.map((t) => t.kind).sort();
    expect(kinds).toEqual(['prompt_submit', 'tool_call']);
  });

  it('fails with parse-error pointing at the offending gate name when check expression is malformed', () => {
    // Unterminated function call — provokes a true parse failure (vs. mere
    // unknown-function name, which the permissive parser accepts and fails
    // only at evaluation time).
    const r = compileVerifyGates('p', [gate({ name: 'bad-gate', check: 'contains(' })]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.gateName).toBe('bad-gate');
    expect(r.errors[0]?.message).toMatch(/parse|RParen|unexpected/i);
  });

  it('collects ALL parse errors across a multi-gate batch — no early-exit on first failure', () => {
    const r = compileVerifyGates('p', [
      gate({ name: 'good' }),
      gate({ name: 'bad1', check: '@@@' }),
      gate({ name: 'bad2', check: 'contains(' }),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map((e) => e.gateName).sort()).toEqual(['bad1', 'bad2']);
  });

  it('compiles a gate with event_kind: prompt_submit into a prompt_submit-only trigger', () => {
    const r = compileVerifyGates('p', [
      gate({ when: { event_kind: 'prompt_submit' }, check: 'contains(prompt, "rm")' }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.triggers).toEqual([{ kind: 'prompt_submit' }]);
  });

  it('synthetic skill carries empty requires + when_to_load (no implicit preconditions)', () => {
    const r = compileVerifyGates('p', [gate()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.requires).toEqual([]);
    expect(r.skill.when_to_load).toEqual([]);
  });

  it('synthetic skill name is namespaced under pack (`<pack>/verify`) for audit-trail attribution', () => {
    const r = compileVerifyGates('focused-react-19', [gate()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.name).toBe('focused-react-19/verify');
  });
});

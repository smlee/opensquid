import { describe, expect, it } from 'vitest';

import { classifyDurability } from './durability.js';

describe('classifyDurability (SCI.1, wg-4f91e0b5cb8c)', () => {
  it('explicit arg always wins', () => {
    // Even content that LOOKS durable is point_in_time when the caller says so, and vice-versa.
    expect(classifyDurability('a plain principle', 'point_in_time')).toBe('point_in_time');
    expect(classifyDurability('2026-06-09 HANDOFF — ship X', 'durable')).toBe('durable');
  });

  it('classifies leading HANDOFF/RESUME/TO SHIP markers as point_in_time', () => {
    // The live offenders (mem-0eac71e81ae814ab, mem-319636e956faf1e4) — author:user yet point-in-time.
    expect(classifyDurability('2026-06-09 HANDOFF — 2 audit-found bug fixes to ship')).toBe(
      'point_in_time',
    );
    expect(classifyDurability('RESUME: opensquid 0.5.373 unpushed; fresh session resets it')).toBe(
      'point_in_time',
    );
    expect(classifyDurability('Both fixes are TO SHIP in a fresh session')).toBe('point_in_time');
  });

  it('classifies principle/architecture memories as durable (no marker)', () => {
    expect(
      classifyDurability('Audit is an end-to-end walk-through of the change, not just tests'),
    ).toBe('durable');
    expect(classifyDurability("Don't patch-bump a doomed version line")).toBe('durable');
  });

  it('only scans the leading prose — a deep mention of "handoff" does not flip a durable memory', () => {
    const durableBody =
      'The Simplicity Principle says every lifecycle is an explicit FSM. '.repeat(8) +
      ' (incidentally this also applies to the handoff machinery).';
    expect(classifyDurability(durableBody)).toBe('durable');
  });

  it('empty / no-signal content fails safe to durable', () => {
    expect(classifyDurability('')).toBe('durable');
    expect(classifyDurability('ok')).toBe('durable');
  });
});

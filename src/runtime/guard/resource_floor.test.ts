/** T2 — Resource floor: the iteration-budget EFSM (warn approaching, halt at the cap). */
import { describe, expect, it } from 'vitest';

import { DEFAULT_WARN_OFFSET, ResourceFloor } from './resource_floor.js';

describe('ResourceFloor (T2)', () => {
  it('cap=8, warnOffset=1 → pass ×6, warn at cap-1 (7th), halt at cap (8th)', () => {
    const f = new ResourceFloor({ cap: 8, warnOffset: 1 });
    const seq = Array.from({ length: 8 }, () => f.observe());
    expect(seq).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'warn', 'halt']);
  });

  it('default warn offset is 1 → warn fires on the single iteration before the cap', () => {
    expect(DEFAULT_WARN_OFFSET).toBe(1);
    const f = new ResourceFloor({ cap: 3, warnOffset: DEFAULT_WARN_OFFSET });
    expect([f.observe(), f.observe(), f.observe()]).toEqual(['pass', 'warn', 'halt']);
  });

  it('a wider warnOffset widens the warn band (config-driven, NOT a literal cap-2)', () => {
    const f = new ResourceFloor({ cap: 3, warnOffset: 2 });
    // cap-warnOffset = 1 → warn from the 1st; halt at the 3rd
    expect([f.observe(), f.observe(), f.observe()]).toEqual(['warn', 'warn', 'halt']);
  });

  it('halts AT the cap and stays halted past it (never silently advances)', () => {
    const f = new ResourceFloor({ cap: 2, warnOffset: 1 });
    expect(f.observe()).toBe('warn'); // count 1, cap-1=1
    expect(f.observe()).toBe('halt'); // count 2 == cap
    expect(f.observe()).toBe('halt'); // count 3 > cap — still halt
    expect(f.count_()).toBe(3);
  });
});

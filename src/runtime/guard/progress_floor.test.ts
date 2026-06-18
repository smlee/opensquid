/** GUARD.1 — the Progress-floor EFSM (Hermes thresholds, severity-max). */
import { describe, expect, it } from 'vitest';

import { ProgressFloor, type ToolObservation } from './progress_floor.js';

const fail = (tool: string, argsHash: string): ToolObservation => ({
  tool,
  argsHash,
  failed: true,
  idempotentSameResult: false,
});
const noProgress = (tool: string, argsHash: string): ToolObservation => ({
  tool,
  argsHash,
  failed: false,
  idempotentSameResult: true,
});
const ok = (tool: string, argsHash: string): ToolObservation => ({
  tool,
  argsHash,
  failed: false,
  idempotentSameResult: false,
});

describe('ProgressFloor EFSM (GUARD.1)', () => {
  it('exact-failure: warn at 2, block at 5 (same tool + identical args)', () => {
    const f = new ProgressFloor();
    expect(f.observe(fail('bash', 'a'))).toBe('pass'); // 1
    expect(f.observe(fail('bash', 'a'))).toBe('warn'); // 2 → warn
    expect(f.observe(fail('bash', 'a'))).toBe('warn'); // 3
    expect(f.observe(fail('bash', 'a'))).toBe('warn'); // 4
    expect(f.observe(fail('bash', 'a'))).toBe('block'); // 5 → block
  });

  it('same-tool failure (distinct args): warn at 3, halt at 8', () => {
    const f = new ProgressFloor();
    const r: string[] = [];
    for (let i = 1; i <= 8; i++) r.push(f.observe(fail('edit', `arg${i}`))); // each arg distinct → exact stays 1
    expect(r[0]).toBe('pass'); // same_tool=1
    expect(r[1]).toBe('pass'); // same_tool=2
    expect(r[2]).toBe('warn'); // same_tool=3 → warn
    expect(r[6]).toBe('warn'); // same_tool=7
    expect(r[7]).toBe('halt'); // same_tool=8 → halt (most severe)
  });

  it('idempotent no-progress: warn at 2, block at 5', () => {
    const f = new ProgressFloor();
    expect(f.observe(noProgress('read', 'x'))).toBe('pass'); // 1
    expect(f.observe(noProgress('read', 'x'))).toBe('warn'); // 2 → warn
    expect(f.observe(noProgress('read', 'x'))).toBe('warn'); // 3
    expect(f.observe(noProgress('read', 'x'))).toBe('warn'); // 4
    expect(f.observe(noProgress('read', 'x'))).toBe('block'); // 5 → block
  });

  it('severity-max: a same-tool halt outranks a co-tripping exact warn', () => {
    const f = new ProgressFloor();
    // 7 failures with identical args: exact=7 (>=5 block), same_tool=7
    for (let i = 0; i < 7; i++) f.observe(fail('t', 'same'));
    // 8th identical failure: exact=8 (block) AND same_tool=8 (halt) → halt wins (severity-max)
    expect(f.observe(fail('t', 'same'))).toBe('halt');
  });

  it('a passing/progressing call resets nothing prematurely (no loop masking)', () => {
    const f = new ProgressFloor();
    f.observe(fail('bash', 'a')); // exact=1
    f.observe(fail('bash', 'a')); // exact=2 → warn
    expect(f.observe(ok('bash', 'b'))).toBe('pass'); // a success does NOT zero the counter
    expect(f.observe(fail('bash', 'a'))).toBe('warn'); // exact=3 → still warns (counter persisted)
  });

  it('a failure clears the no-progress tracker for that signature (Hermes pop)', () => {
    const f = new ProgressFloor();
    f.observe(noProgress('read', 'x')); // no_progress=1
    f.observe(noProgress('read', 'x')); // no_progress=2 → warn
    f.observe(fail('read', 'x')); // failure pops no_progress[x]
    // no-progress count restarts from 1 → pass (not warn), proving the pop
    expect(f.observe(noProgress('read', 'x'))).toBe('pass');
  });

  it('counts() exposes the max counter per category', () => {
    const f = new ProgressFloor();
    f.observe(fail('bash', 'a'));
    f.observe(fail('bash', 'a'));
    expect(f.counts()).toEqual({ exact: 2, sameTool: 2, noProgress: 0 });
  });
});

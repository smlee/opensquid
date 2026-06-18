/** P0.3 — observeCall: the live failure-loop detector over persisted floor state. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { floorMessage, observeCall } from './floor_hook.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'osq-floorhook-'));
  process.env.OPENSQUID_HOME = home;
});

const failBash = { tool: 'Bash', args: { command: 'x' }, exitCode: 1 };

describe('observeCall (P0.3)', () => {
  it('exact_failure: the 5th identical failed call → block (counters persist across reloads)', async () => {
    const s = 'sess-exact';
    const r: string[] = [];
    for (let i = 0; i < 5; i++) r.push(await observeCall(s, failBash)); // each reloads from disk
    expect(r).toEqual(['pass', 'warn', 'warn', 'warn', 'block']); // 2→warn, 5→block
  });

  it('same_tool: 8 failures of the same tool with DISTINCT args → halt', async () => {
    const s = 'sess-sametool';
    const r: string[] = [];
    for (let i = 1; i <= 8; i++)
      r.push(await observeCall(s, { tool: 'Edit', args: { n: i }, exitCode: 1 }));
    expect(r[2]).toBe('warn'); // same_tool=3
    expect(r[7]).toBe('halt'); // same_tool=8
  });

  it('a passing call (exitCode 0) → pass; does not reset a prior failure streak', async () => {
    const s = 'sess-pass';
    await observeCall(s, failBash); // exact=1
    await observeCall(s, failBash); // exact=2 → warn
    expect(await observeCall(s, { tool: 'Bash', args: { command: 'x' }, exitCode: 0 })).toBe(
      'pass',
    );
    expect(await observeCall(s, failBash)).toBe('warn'); // exact=3 (not reset by the pass)
  });

  it('a tool that reports exitCode 0 is never tracked as failed (no false fire)', async () => {
    const s = 'sess-ok';
    const r: string[] = [];
    for (let i = 0; i < 6; i++)
      r.push(await observeCall(s, { tool: 'Read', args: { p: 'f' }, exitCode: 0 }));
    expect(r.every((a) => a === 'pass')).toBe(true); // no_progress deferred → no escalation
  });

  it('floorMessage names the tool for each non-pass action', () => {
    expect(floorMessage('warn', 'Bash')).toMatch(/Bash.*change strategy/);
    expect(floorMessage('block', 'Bash')).toMatch(/STOP retrying/);
    expect(floorMessage('halt', 'Edit')).toMatch(/stop this tool path/);
  });
});

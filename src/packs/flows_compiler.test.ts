/**
 * Tests for `compileFlows` (FC.2, the FSM FLOW template subsystem) + its
 * loader integration: the compiled fragment is merged into fsm.yaml BEFORE
 * validateFsm, so totality is checked on the EXPANDED machine.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compileFlows } from './flows_compiler.js';
import { loadPack } from './loader.js';

describe('compileFlows — pure expansion', () => {
  it('loopback_gate expands to the one re-do edge (endpoints must pre-exist in fsm.yaml)', () => {
    const r = compileFlows('p', [
      {
        template: 'loopback_gate',
        params: { state: 'researched', trigger: 'guess_found', back_to: 'researching' },
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expansion.transitions).toEqual([
      { from: 'researched', on: 'guess_found', to: 'researching' },
    ]);
    expect(r.expansion.states).toEqual([]); // a loop-back connects existing states
  });

  it('empty flows → ok with an empty expansion', () => {
    const r = compileFlows('p', []);
    expect(r).toEqual({ ok: true, expansion: { states: [], transitions: [] } });
  });

  it('unknown template → fail-loud (no silent skip)', () => {
    const r = compileFlows('p', [{ template: 'no_such_template', params: {} }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/unknown flow template "no_such_template"/);
  });

  it('loopback_gate with non-string params → fail-loud', () => {
    const r = compileFlows('p', [
      { template: 'loopback_gate', params: { state: 'a', trigger: 'x' } },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(/loopback_gate requires string params/);
  });

  it('accumulates transitions across multiple flows', () => {
    const r = compileFlows('p', [
      { template: 'loopback_gate', params: { state: 'a', trigger: 't1', back_to: 'b' } },
      { template: 'loopback_gate', params: { state: 'a', trigger: 't2', back_to: 'b' } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expansion.transitions).toEqual([
      { from: 'a', on: 't1', to: 'b' },
      { from: 'a', on: 't2', to: 'b' },
    ]);
  });
});

describe('flows ↔ fsm merge (via loadPack)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'opensquid-flows-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const MANIFEST = (flows: string): string =>
    `name: flowtest\nversion: 0.1.0\nscope: workflow\ngoal: test the flow merge\n${flows}`;

  it('a valid flow merges its transition into the fsm.yaml machine', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      MANIFEST(
        'flows:\n  - template: loopback_gate\n    params: { state: a, trigger: redo, back_to: b }\n',
      ),
    );
    await writeFile(join(dir, 'fsm.yaml'), 'initial: a\nstates: [a, b]\ntransitions: []\n');
    const pack = await loadPack(dir);
    expect(pack.fsm?.transitions).toContainEqual({ from: 'a', on: 'redo', to: 'b' });
  });

  it('totality is checked on the MERGED machine: a flow edge to an undeclared state throws', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      MANIFEST(
        'flows:\n  - template: loopback_gate\n    params: { state: a, trigger: redo, back_to: typo }\n',
      ),
    );
    await writeFile(join(dir, 'fsm.yaml'), 'initial: a\nstates: [a, b]\ntransitions: []\n');
    await expect(loadPack(dir)).rejects.toThrow(/invalid FSM/);
  });

  it('flows declared with no fsm.yaml → loud load error', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      MANIFEST(
        'flows:\n  - template: loopback_gate\n    params: { state: a, trigger: redo, back_to: b }\n',
      ),
    );
    await expect(loadPack(dir)).rejects.toThrow(/no fsm.yaml to merge into/);
  });

  it('an unknown template throws at load', async () => {
    await writeFile(
      join(dir, 'manifest.yaml'),
      MANIFEST('flows:\n  - template: bogus\n    params: {}\n'),
    );
    await writeFile(join(dir, 'fsm.yaml'), 'initial: a\nstates: [a]\ntransitions: []\n');
    await expect(loadPack(dir)).rejects.toThrow(/unknown flow template "bogus"/);
  });
});

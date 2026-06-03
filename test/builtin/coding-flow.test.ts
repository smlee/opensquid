/**
 * Built-in `coding-flow` pack (T-FSM-UNIFY) — the unified, FSM-driven
 * problem-solving discipline that supersedes scope-fsm + workflow-fsm. FU.1
 * covers the FSM backbone only (manifest + fsm.yaml); the guards land in FU.2.
 * This proves the on-disk union machine loads + is total, with the three
 * region-defining edges intact (guess-audit loop-back, spec-audit advance).
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadPack } from '../../src/packs/loader.js';
import { step, validateFsm } from '../../src/runtime/fsm.js';

describe('builtin coding-flow pack — FSM backbone (FU.1)', () => {
  it('loads with the union FSM and is total (validateFsm clean)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(pack.name).toBe('coding-flow');
    expect(pack.fsm?.initial).toBe('idle');
    expect(pack.fsm?.states).toEqual([
      'idle',
      'scoping',
      'researching',
      'researched',
      'spec_authored',
      'spec_complete',
      'tasks_loaded',
      'phases_in_flight',
      'phases_complete',
    ]);
    expect(validateFsm(pack.fsm!)).toEqual([]);
  });

  it('SCOPE: guess-audit loops researched back to researching (D3)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'guess_found')).toMatchObject({
      next: 'researching',
      transitioned: true,
    });
    expect(step(pack.fsm!, 'researching', 'research_done')).toMatchObject({
      next: 'researched',
      transitioned: true,
    });
  });

  it('AUTHOR: spec-audit advances spec_authored → spec_complete, then tasks_loaded (D7)', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'spec_drafted')).toMatchObject({ next: 'spec_authored' });
    expect(step(pack.fsm!, 'spec_authored', 'spec_verified')).toMatchObject({
      next: 'spec_complete',
    });
    expect(step(pack.fsm!, 'spec_complete', 'tasks_loaded')).toMatchObject({
      next: 'tasks_loaded',
    });
  });

  it('is total: an unmatched event is an explicit stay, never a crash', async () => {
    const pack = await loadPack(resolve('packs/builtin', 'coding-flow'));
    expect(step(pack.fsm!, 'researched', 'no_such_event')).toMatchObject({
      next: 'researched',
      transitioned: false,
    });
    // spec_complete cannot be skipped: a stray research_done at spec_authored stays put
    expect(step(pack.fsm!, 'spec_authored', 'research_done')).toMatchObject({
      next: 'spec_authored',
      transitioned: false,
    });
  });
});

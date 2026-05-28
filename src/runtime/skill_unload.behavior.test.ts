/**
 * CU.3 — skill-unload behavior + cross-process persistence (end-to-end).
 *
 * Proves the CU.1 (persisted ticks) + CU.2 (dispatch wiring) integration end
 * to end: a skill declaring `unloads_when` actually stops injecting its prose
 * at runtime, through the REAL dispatcher. The load-bearing assertion is at the
 * dispatcher OUTPUT — `DispatchResult.contextInjections` (the prose the
 * UserPromptSubmit hook would emit as host context) — NOT just
 * `shouldUnload === true` in a unit. That is the difference between "the gate
 * computes" and "the gate is wired" (the MAU.1 lesson: prove the integration,
 * not the unit).
 *
 * Each "turn" is one `prompt_submit` dispatch. Skills inject a marker string so
 * we can read presence/absence straight off `contextInjections`. State persists
 * via a scoped tmp OPENSQUID_HOME so the test's tick files never pollute the
 * real session — and so the cross-process assertion (ticks written by one
 * dispatch are read by the next) exercises the same disk path a real hook bin
 * would.
 *
 * Covers: idle-N unload (prose suppressed at output), re-activation reset,
 * pinned never unloads, empty unloads_when never unloads, active_task_completes
 * on a stop event, and cross-process persistence against tmp OPENSQUID_HOME.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FunctionRegistry } from '../functions/registry.js';
import { dispatchEvent } from './hooks/dispatch.js';
import { ok } from './result.js';
import { sessionStateFile } from './paths.js';
import { readSkillTicks } from './session_state.js';
import type { Event, Pack, Skill } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const promptSubmit: Event = { kind: 'prompt_submit', prompt: 'go' };
const stop: Event = { kind: 'stop', assistantText: 'done' };

/**
 * A registry whose `inject_<name>` primitive emits a per-skill marker. We
 * register one emitter per skill so each skill's prose is independently
 * observable in `contextInjections`.
 */
function buildInjectRegistry(markers: string[]): FunctionRegistry {
  const r = new FunctionRegistry();
  for (const m of markers) {
    r.register({
      name: `inject_${m}`,
      argSchema: z.record(z.unknown()),
      // eslint-disable-next-line @typescript-eslint/require-await -- async to match FunctionDef contract
      execute: async () => ok({ kind: 'inject_context' as const, content: `PROSE:${m}` }),
    });
  }
  return r;
}

/** A pack with one prose-injecting skill, configurable lifecycle. */
function prosePack(opts: {
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
    requires: [],
    unloads_when: opts.unloads_when,
    triggers: [{ kind: 'prompt_submit' }],
    rules: [
      {
        id: `${opts.name}-inject`,
        kind: 'track_check',
        requires: [],
        process: [{ call: `inject_${opts.name}` }],
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
  };
}

/** True iff the dispatch output carries this skill's prose marker. */
function prosePresent(injections: string[], marker: string): boolean {
  return injections.includes(`PROSE:${marker}`);
}

// ---------------------------------------------------------------------------
// Scoped tmp HOME — the persistence backing for ticks.
// ---------------------------------------------------------------------------

let tempHome: string;
let priorHome: string | undefined;

beforeEach(async () => {
  priorHome = process.env.OPENSQUID_HOME;
  tempHome = await mkdtemp(join(tmpdir(), 'opensquid-skill-unload-e2e-'));
  process.env.OPENSQUID_HOME = tempHome;
});

afterEach(async () => {
  if (priorHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = priorHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('CU.3: skill-unload behavior (prose suppressed at dispatcher output)', () => {
  it('idle_n_turns:2 → prose present turns 1–2, SKIPPED turn 3 (no prose)', async () => {
    const registry = buildInjectRegistry(['dyn']);
    const pack = prosePack({
      name: 'dyn',
      scope: 'workflow',
      load: 'lazy',
      unloads_when: [{ idle_n_turns: 2 }],
    });
    const sid = 'e2e-idle2';

    // Turn 1: tick→1 (<2) → walks → prose present.
    const t1 = await dispatchEvent(promptSubmit, [pack], registry, sid);
    expect(prosePresent(t1.contextInjections, 'dyn')).toBe(true);

    // Turn 2: tick→2 (≥2) → unload fires → SKIPPED.
    // Note the gate is evaluated AFTER the advance for this event, so the
    // suppression lands on the turn the counter reaches n, not the turn after.
    const t2 = await dispatchEvent(promptSubmit, [pack], registry, sid);
    expect(prosePresent(t2.contextInjections, 'dyn')).toBe(false);

    // Turn 3: still skipped (counter keeps climbing past n).
    const t3 = await dispatchEvent(promptSubmit, [pack], registry, sid);
    expect(prosePresent(t3.contextInjections, 'dyn')).toBe(false);
  });

  it('re-activation: when_to_load match resets the tick → prose returns', async () => {
    const registry = buildInjectRegistry(['react', 'idle']);
    // `react` re-matches its when_to_load every prompt_submit → tick resets
    // each turn → idle_n_turns:2 never reaches 2 → prose always present.
    const reactPack = prosePack({
      name: 'react',
      scope: 'workflow',
      load: 'lazy',
      unloads_when: [{ idle_n_turns: 2 }],
      when_to_load: [{ event_type: 'prompt_submit' }],
    });
    // `idle` has NO when_to_load → never resets → unloads at turn 2 (control).
    const idlePack = prosePack({
      name: 'idle',
      scope: 'workflow',
      load: 'lazy',
      unloads_when: [{ idle_n_turns: 2 }],
    });
    const sid = 'e2e-react';

    for (let turn = 1; turn <= 4; turn++) {
      const r = await dispatchEvent(promptSubmit, [reactPack, idlePack], registry, sid);
      // Re-activating skill: tick resets to fresh each turn (→1, <2) → ALWAYS present.
      expect(prosePresent(r.contextInjections, 'react')).toBe(true);
      // Control skill: present turn 1, gone turn ≥2.
      expect(prosePresent(r.contextInjections, 'idle')).toBe(turn < 2);
    }
  });

  it('PINNED skill (universal+preload) NEVER unloads even with idle_n_turns:1', async () => {
    const registry = buildInjectRegistry(['pin']);
    const pack = prosePack({
      name: 'pin',
      scope: 'universal',
      load: 'preload',
      unloads_when: [{ idle_n_turns: 1 }], // pathological — pinned wins
    });
    const sid = 'e2e-pinned';
    for (let turn = 1; turn <= 4; turn++) {
      const r = await dispatchEvent(promptSubmit, [pack], registry, sid);
      expect(prosePresent(r.contextInjections, 'pin')).toBe(true);
    }
  });

  it('empty unloads_when → prose present on every turn (no regression)', async () => {
    const registry = buildInjectRegistry(['always']);
    const pack = prosePack({
      name: 'always',
      scope: 'workflow',
      load: 'lazy',
      unloads_when: [],
    });
    const sid = 'e2e-empty';
    for (let turn = 1; turn <= 5; turn++) {
      const r = await dispatchEvent(promptSubmit, [pack], registry, sid);
      expect(prosePresent(r.contextInjections, 'always')).toBe(true);
    }
  });

  it('active_task_completes → a stop event latches taskCompleted → skill unloads next dispatch', async () => {
    // The skill subscribes to BOTH prompt_submit (to inject prose) and stop
    // (so the stop tick advance runs through its own dispatch). After the stop
    // latches taskCompleted, the next prompt_submit dispatch finds the latch
    // and suppresses the prose.
    const registry = buildInjectRegistry(['task']);
    const skill: Skill = {
      name: 'task-skill',
      load: 'lazy',
      when_to_load: [],
      requires: [],
      unloads_when: ['active_task_completes'],
      triggers: [{ kind: 'prompt_submit' }, { kind: 'stop' }],
      rules: [
        {
          id: 'task-inject',
          kind: 'track_check',
          requires: [],
          process: [{ call: 'inject_task' }],
        },
      ],
    };
    const pack: Pack = {
      name: 'task',
      version: '0.0.0',
      scope: 'workflow',
      goal: 'test',
      description: '',
      requires: [],
      conflicts: [],
      evolves: true,
      skills: [skill],
    };
    const sid = 'e2e-task-complete';

    // Turn 1: prose present (no latch yet).
    const t1 = await dispatchEvent(promptSubmit, [pack], registry, sid);
    expect(prosePresent(t1.contextInjections, 'task')).toBe(true);

    // Stop event: advances the tick, latching taskCompleted (no prose on a
    // stop event regardless — inject only surfaces on prompt_submit).
    await dispatchEvent(stop, [pack], registry, sid);

    // Next prompt_submit: the latch is read → unload fires → prose suppressed.
    const t2 = await dispatchEvent(promptSubmit, [pack], registry, sid);
    expect(prosePresent(t2.contextInjections, 'task')).toBe(false);
  });
});

describe('CU.3: cross-process persistence against tmp OPENSQUID_HOME', () => {
  it('ticks written by one dispatch are read by the next (persisted, not in-memory)', async () => {
    const registry = buildInjectRegistry(['xp']);
    const pack = prosePack({
      name: 'xp',
      scope: 'workflow',
      load: 'lazy',
      unloads_when: [{ idle_n_turns: 5 }], // high so it never unloads in this test
    });
    const sid = 'e2e-cross-process';

    // "Process 1": one dispatch → tick on disk at 1.
    await dispatchEvent(promptSubmit, [pack], registry, sid);
    const afterOne = await readSkillTicks(sid);
    expect(afterOne['xp-skill']?.turnsSinceActivation).toBe(1);

    // The tick file physically exists at the expected session-state path
    // (proves persistence, not an in-memory Map).
    const onDisk = JSON.parse(
      await readFile(sessionStateFile(sid, 'skill-ticks'), 'utf8'),
    ) as Record<string, { turnsSinceActivation: number }>;
    expect(onDisk['xp-skill']?.turnsSinceActivation).toBe(1);

    // "Process 2": a fresh dispatch reads the prior count off disk → +1.
    await dispatchEvent(promptSubmit, [pack], registry, sid);
    const afterTwo = await readSkillTicks(sid);
    expect(afterTwo['xp-skill']?.turnsSinceActivation).toBe(2);
  });
});

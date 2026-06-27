/**
 * R-SKILLS-PER-STATE live proof (T-v2-track1-finish, SKILL.1). Fails-on-dormancy: drives the REAL host seam
 * `runV2Cartridges` and asserts `onStateEntry` bound the CURRENT state's skills onto `V2Decision.boundSkills`.
 * If the `onStateEntry(actor.state.current, …)` wiring in v2_supply.ts is removed, `boundSkills` is empty → red.
 *
 * Two cases per pre-research §4.1: (1) steady-state — sitting in a skilled executor, an event that does NOT
 * advance still binds skills(S) [the state IS the router, every event]; (2) transition — a gate advances INTO
 * the skilled executor and the entered state's skills are bound via the live transition path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { compilePackV2 } from '../../packs/compile_v2.js';
import type { LoadedPackV2 } from '../../packs/loader_v2.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import type { Event } from '../event.js';

vi.mock('../bootstrap.js', () => ({ loadActiveV2Cartridges: vi.fn() }));
import { loadActiveV2Cartridges } from '../bootstrap.js';
import { runV2Cartridges } from '../loop/v2_supply.js';
import { FunctionRegistry } from '../../functions/registry.js';

const mockLoad = vi.mocked(loadActiveV2Cartridges);
// These packs carry `skills: []` (no loaded skills to host-evaluate), so an empty registry satisfies the
// runV2Cartridges signature without registering any primitive.
const REG = new FunctionRegistry();

function load(spec: unknown): LoadedPackV2 {
  const pack = PackV2.parse(spec);
  return {
    pack,
    compiled: compilePackV2(pack),
    guards: pack.guards,
    messages: pack.messages,
    skills: [],
  };
}

// (1) Steady-state: the INITIAL state is a skilled executor (no `serves` → ORCH.8 doesn't force a gate-initial).
// An executor is not a transition-source (v2_observed_actor.ts:74), so an event does NOT advance — yet the
// current state's skills must still bind (state-is-the-router, every event).
const steadyPack = (): LoadedPackV2 =>
  load({
    name: 'skilled-steady',
    version: '1.0.0',
    scope: 'workflow',
    guards: { done: 'event == "tool_call"' },
    fsm: {
      initial: 'work',
      states: {
        work: {
          kind: 'executor',
          skills: ['alpha', 'beta'],
          directive: 'do the work',
          completion: 'done',
          emits: 'finished',
        },
        end: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'work', on: 'finished', to: 'end' }],
    },
  });

// (2) Transition: a gate (binds [], compile_v2.ts:93-95) with an always-true guard advances INTO the skilled
// executor; the actor stops there (v2_observed_actor.ts:74). The ENTERED executor's skills must be bound.
const transitionPack = (): LoadedPackV2 =>
  load({
    name: 'skilled-transition',
    version: '1.0.0',
    scope: 'workflow',
    guards: { go: 'event == "tool_call"', done: 'event == "tool_call"' },
    fsm: {
      initial: 'g0',
      states: {
        g0: {
          kind: 'gate',
          guard: 'go',
          trigger: ['tool_call'],
          on_pass_emits: 'start',
          on_fail: { action: 'warn', message: 'not yet' },
        },
        work: {
          kind: 'executor',
          skills: ['alpha', 'beta'],
          directive: 'do the work',
          completion: 'done',
          emits: 'finished',
        },
        end: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [
        { from: 'g0', on: 'start', to: 'work' },
        { from: 'work', on: 'finished', to: 'end' },
      ],
    },
  });

const toolCall = (): Event => ({ kind: 'tool_call', tool: 'Bash', args: {} }) as unknown as Event;
const NOW = '2026-06-25T00:00:00.000Z';

beforeEach(() => mockLoad.mockReset());

describe('SKILL.1 live binding (R-SKILLS-PER-STATE)', () => {
  it('steady-state: an event in a skilled executor binds skills(S) every event (no transition needed)', async () => {
    mockLoad.mockResolvedValue([steadyPack()]);
    const d = await runV2Cartridges('sess-skill-steady', toolCall(), NOW, REG);
    expect(d.boundSkills).toEqual(['alpha', 'beta']);
  });

  it('transition: advancing a gate INTO the skilled executor binds the ENTERED state skills (live path)', async () => {
    mockLoad.mockResolvedValue([transitionPack()]);
    const d = await runV2Cartridges('sess-skill-transition', toolCall(), NOW, REG);
    expect(d.boundSkills).toEqual(['alpha', 'beta']);
  });

  it('a non-skilled (gate-only) cartridge binds the empty set — no false skills', async () => {
    // g0 is a gate (skills []) that fails its trigger? No — drive a non-trigger event so it sits at the gate.
    mockLoad.mockResolvedValue([transitionPack()]);
    const promptEvent = { kind: 'prompt_submit' } as unknown as Event;
    const d = await runV2Cartridges('sess-skill-gate', promptEvent, NOW, REG);
    expect(d.boundSkills).toEqual([]); // sat at gate g0 (binds []) — dormancy would also be [], but see other cases
  });
});

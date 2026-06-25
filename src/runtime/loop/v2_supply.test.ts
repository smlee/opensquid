/** FAC-CUT.5b.2 — runV2Cartridges: in-process v2 host supply (inert / gate-fires+persist / non-trigger / fail-open). */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { compilePackV2 } from '../../packs/compile_v2.js';
import { PackV2 } from '../../packs/schemas/pack_v2.js';
import type { LoadedPackV2 } from '../../packs/loader_v2.js';
import { readFsmStateRaw } from '../fsm_state.js';
import type { Event } from '../event.js';

// Mock the cartridge loader so each test controls the active v2 set.
vi.mock('../bootstrap.js', () => ({ loadActiveV2Cartridges: vi.fn() }));
import { loadActiveV2Cartridges } from '../bootstrap.js';
import { runV2Cartridges } from './v2_supply.js';

const mockLoad = vi.mocked(loadActiveV2Cartridges);

/** Build a LoadedPackV2 from an inline PackV2 (mirrors v2_observed_actor.test.ts). */
function load(spec: unknown): LoadedPackV2 {
  const pack = PackV2.parse(spec);
  return { pack, compiled: compilePackV2(pack), guards: pack.guards, messages: pack.messages };
}

/** A gate triggered by tool_call whose guard is `tool == "Write"`. A `Bash` tool_call FAILS the guard →
 *  the `onFail` action fires (deterministic; `tool` is bound by buildGuardCtx, so no missing-key throw). */
const gatePack = (onFailAction: 'block' | 'warn') =>
  load({
    name: 'observed-gate',
    version: '1.0.0',
    scope: 'workflow',
    guards: { ok: 'tool == "Write"' },
    fsm: {
      initial: 'g0',
      states: {
        g0: {
          kind: 'gate',
          guard: 'ok',
          trigger: ['tool_call'],
          on_pass_emits: 'done',
          on_fail: { action: onFailAction, message: 'resolve it' },
        },
        shipped: { kind: 'terminal', outcome: 'shipped' },
      },
      transitions: [{ from: 'g0', on: 'done', to: 'shipped' }],
    },
  });

const bashCall = (): Event => ({ kind: 'tool_call', tool: 'Bash', args: {} }) as unknown as Event;

const NOW = '2026-06-22T00:00:00.000Z';

beforeEach(() => mockLoad.mockReset());

describe('runV2Cartridges (FAC-CUT.5b.2)', () => {
  it('INERT: no active v2 cartridges → ZERO decision (the nothing-breaks path)', async () => {
    mockLoad.mockResolvedValue([]);
    const d = await runV2Cartridges('sess-inert', bashCall(), NOW);
    expect(d).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] });
  });

  it('gate FAIL + block → exitCode 2 + message; no advance (state stays at the gate)', async () => {
    mockLoad.mockResolvedValue([gatePack('block')]);
    const d = await runV2Cartridges('sess-block', bashCall(), NOW);
    expect(d.exitCode).toBe(2);
    expect(d.messages).toContain('resolve it');
    expect(d.injections).toEqual([]);
    expect(await readFsmStateRaw('sess-block', 'observed-gate')).toBeNull(); // block = no advance, no write
  });

  it('gate FAIL + warn → exitCode 0 + injection (nudge); advance persisted', async () => {
    mockLoad.mockResolvedValue([gatePack('warn')]);
    const d = await runV2Cartridges('sess-warn', bashCall(), NOW);
    expect(d.exitCode).toBe(0);
    expect(d.injections).toContain('resolve it');
    expect(d.messages).toEqual([]);
    expect(await readFsmStateRaw('sess-warn', 'observed-gate')).toBe('shipped'); // warn = advance + nudge
  });

  it('non-trigger event → ZERO, no state change (await-point)', async () => {
    mockLoad.mockResolvedValue([gatePack('block')]);
    const promptEvent = { kind: 'prompt_submit' } as unknown as Event;
    const d = await runV2Cartridges('sess-nt', promptEvent, NOW);
    expect(d).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] });
    expect(await readFsmStateRaw('sess-nt', 'observed-gate')).toBeNull();
  });

  it('FAIL-OPEN: a cartridge whose receive throws → ZERO for it, no throw escapes', async () => {
    // An fsm with NO meta for its initial state → V2ObservedActor.receive throws "no meta".
    const broken = {
      pack: { name: 'broken' },
      compiled: {
        fsm: { initial: 'x', states: ['x'], transitions: [] },
        meta: {},
        guardExprs: new Map(),
      },
      guards: {},
      messages: {},
    } as unknown as LoadedPackV2;
    mockLoad.mockResolvedValue([broken]);
    const d = await runV2Cartridges('sess-fo', bashCall(), NOW);
    expect(d).toEqual({ exitCode: 0, messages: [], injections: [], boundSkills: [] }); // swallowed, fail-open
  });
});

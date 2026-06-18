/** P0.2 — observability seed: per-advance transition log. */
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { advanceFsmState } from '../fsm_state.js';
import type { Fsm } from '../fsm.js';
import { appendTransition, transitionLogPath, type TransitionRecord } from './transition_log.js';

const FSM: Fsm = {
  initial: 'a',
  states: ['a', 'b', 'c'],
  transitions: [
    { from: 'a', on: 'go', to: 'b' },
    { from: 'b', on: 'go', to: 'c' },
  ],
};

const sid = (): string => `p02-${Math.random().toString(36).slice(2)}`; // unique per test (no shared log)

async function readLog(session: string): Promise<TransitionRecord[]> {
  try {
    const raw = await readFile(transitionLogPath(session), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TransitionRecord);
  } catch {
    return []; // absent log ⇒ no records
  }
}

describe('transition_log (P0.2)', () => {
  it('a transitioning advance appends exactly one record; the result is returned unchanged', async () => {
    const s = sid();
    const r = await advanceFsmState(s, 'demo', FSM, 'go', '2026-06-18T00:00:00Z');
    expect(r).toMatchObject({ transitioned: true, next: 'b' });
    const log = await readLog(s);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ pack: 'demo', from: 'a', to: 'b', on: 'go', via: 0 });
  });

  it('a no-op event (no matching transition) appends ZERO records', async () => {
    const s = sid();
    const r = await advanceFsmState(s, 'demo', FSM, 'nope', '2026-06-18T00:00:00Z');
    expect(r.transitioned).toBe(false);
    expect(await readLog(s)).toHaveLength(0);
  });

  it('the record carries {session, pack, from, to, on, at, via} with via a number', async () => {
    const s = sid();
    await advanceFsmState(s, 'demo', FSM, 'go', '2026-06-18T12:34:56Z');
    const [rec] = await readLog(s);
    expect(rec).toEqual<TransitionRecord>({
      session: s,
      pack: 'demo',
      from: 'a',
      to: 'b',
      on: 'go',
      at: '2026-06-18T12:34:56Z',
      via: 0,
    });
    expect(typeof rec!.via).toBe('number');
  });

  it('TWO packs in one session → ONE shared per-session log, interleaved in advance-order', async () => {
    const s = sid();
    await advanceFsmState(s, 'packA', FSM, 'go', '2026-06-18T00:00:01Z'); // a→b (packA)
    await advanceFsmState(s, 'packB', FSM, 'go', '2026-06-18T00:00:02Z'); // a→b (packB)
    await advanceFsmState(s, 'packA', FSM, 'go', '2026-06-18T00:00:03Z'); // b→c (packA)
    const log = await readLog(s);
    expect(log.map((r) => `${r.pack}:${r.from}->${r.to}`)).toEqual([
      'packA:a->b',
      'packB:a->b',
      'packA:b->c',
    ]); // cross-pack ordering preserved in the single shared log
  });

  it('appendTransition is pure-append: a second record does not overwrite the first', async () => {
    const s = sid();
    const base: TransitionRecord = {
      session: s,
      pack: 'p',
      from: 'a',
      to: 'b',
      on: 'go',
      at: 't1',
      via: 0,
    };
    await appendTransition(base);
    await appendTransition({ ...base, from: 'b', to: 'c', at: 't2', via: 1 });
    expect(await readLog(s)).toHaveLength(2);
  });
});

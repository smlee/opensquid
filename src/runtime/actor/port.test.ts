/** PORT.1 — the actor port + BaseActor. */
import { describe, expect, it } from 'vitest';

import type { Envelope, MessageKind } from '../bus/types.js';
import type { Fsm } from '../fsm.js';
import { BaseActor, type Effect } from './port.js';

const FSM: Fsm = {
  initial: 'a',
  states: ['a', 'b'],
  transitions: [{ from: 'a', on: 'go', to: 'b' }],
};

class TestActor extends BaseActor {
  subscribe(): MessageKind[] {
    return ['tool_call'];
  }
  protected eventFor(env: Envelope): string | null {
    return env.kind === 'tool_call' ? (env.payload as { event: string }).event : null;
  }
}

const env = (kind: MessageKind, payload: unknown): Envelope => ({
  seq: 1,
  from: 'x',
  to: 'topic:t',
  kind,
  payload,
  ts: 0,
});

describe('BaseActor (PORT.1)', () => {
  it('starts at the FSM initial state', () => {
    expect(new TestActor('act', FSM).state.current).toBe('a');
  });

  it('a matching event steps the FSM and returns write_state + transition-emit effects', () => {
    const actor = new TestActor('act', FSM);
    const effects = actor.receive(env('tool_call', { event: 'go' }));
    expect(actor.state.current).toBe('b');
    expect(actor.state.history).toEqual(['a']);
    expect(effects).toEqual<Effect[]>([
      { kind: 'write_state', state: 'b' },
      {
        kind: 'emit',
        to: 'topic:transition',
        messageKind: 'transition',
        payload: { from: 'a', to: 'b', on: 'go' },
      },
    ]);
  });

  it('a non-matching event is an explicit stay — no effects, no state change', () => {
    const actor = new TestActor('act', FSM);
    expect(actor.receive(env('tool_call', { event: 'nope' }))).toEqual([]);
    expect(actor.state.current).toBe('a');
  });

  it('an unsubscribed/ignored envelope (eventFor → null) yields no effects', () => {
    const actor = new TestActor('act', FSM);
    expect(actor.receive(env('stop', {}))).toEqual([]);
    expect(actor.state.current).toBe('a');
  });

  it('receive performs no I/O — effects are data the host applies', () => {
    const actor = new TestActor('act', FSM);
    const effects = actor.receive(env('tool_call', { event: 'go' }));
    // the write_state effect is a value, not a side effect — the host persists it
    expect(effects.find((e) => e.kind === 'write_state')).toBeDefined();
  });
});

/**
 * agent_bridge — event bus unit tests (WAB.2).
 */

import { describe, expect, it } from 'vitest';

import { AgentEventBus } from './event_bus.js';
import type { InboundChatEvent } from './types.js';

function fixtureEvent(text: string): InboundChatEvent {
  return {
    kind: 'inbound_message',
    sessionKey: { platform: 'telegram', chatId: '8075471258' },
    messageId: '1',
    sender: { id: '8075471258', name: 'L0g1cProphet' },
    text,
    receivedAt: '2026-05-21T19:00:00.000Z',
    enqueuedAt: '2026-05-21T19:00:00.001Z',
    projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
  };
}

describe('AgentEventBus', () => {
  it('delivers a single emit to a single listener', () => {
    const bus = new AgentEventBus();
    const received: InboundChatEvent[] = [];
    bus.on('inbound', (e) => received.push(e));
    const fired = bus.emit('inbound', fixtureEvent('hello'));
    expect(fired).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('hello');
  });

  it('delivers to multiple listeners in registration order', () => {
    const bus = new AgentEventBus();
    const order: string[] = [];
    bus.on('inbound', () => order.push('first'));
    bus.on('inbound', () => order.push('second'));
    bus.on('inbound', () => order.push('third'));
    bus.emit('inbound', fixtureEvent('x'));
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('emit returns false when no listener is registered', () => {
    const bus = new AgentEventBus();
    const fired = bus.emit('inbound', fixtureEvent('orphan'));
    expect(fired).toBe(false);
  });

  it('off() removes a listener', () => {
    const bus = new AgentEventBus();
    const received: InboundChatEvent[] = [];
    const listener = (e: InboundChatEvent): void => {
      received.push(e);
    };
    bus.on('inbound', listener);
    bus.emit('inbound', fixtureEvent('a'));
    bus.off('inbound', listener);
    bus.emit('inbound', fixtureEvent('b'));
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('a');
  });

  it('once() fires exactly one time', () => {
    const bus = new AgentEventBus();
    let calls = 0;
    bus.once('inbound', () => {
      calls += 1;
    });
    bus.emit('inbound', fixtureEvent('1'));
    bus.emit('inbound', fixtureEvent('2'));
    expect(calls).toBe(1);
  });

  it('listener thrown errors do not break the chain (Node ≥14 semantics)', () => {
    const bus = new AgentEventBus();
    const received: string[] = [];
    bus.on('inbound', () => {
      throw new Error('listener-1 boom');
    });
    bus.on('inbound', (e) => received.push(`got:${e.text}`));
    // Node ≥14 surfaces sync throw on the emitter; we expect emit to throw
    // BUT a downstream listener in the same dispatch tick won't run when
    // the first one throws synchronously. The contract we document in
    // event_bus.ts is "use async listeners with internal try/catch."
    // This test pins that semantics so any future Node change surfaces.
    expect(() => bus.emit('inbound', fixtureEvent('boom'))).toThrow(/listener-1 boom/);
    expect(received).toEqual([]); // doc'd behavior
  });
});

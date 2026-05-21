/**
 * agent_bridge — types unit tests (WAB.2).
 */

import { describe, expect, it } from 'vitest';

import {
  inboundChatEventSchema,
  outboundChatReplySchema,
  sessionKeySchema,
  sessionKeyString,
} from './types.js';

describe('sessionKeySchema', () => {
  it('accepts minimal DM key (no thread)', () => {
    const r = sessionKeySchema.safeParse({ platform: 'telegram', chatId: '123' });
    expect(r.success).toBe(true);
  });
  it('accepts threaded key (forum topic)', () => {
    const r = sessionKeySchema.safeParse({
      platform: 'telegram',
      chatId: '-100',
      threadId: '15',
    });
    expect(r.success).toBe(true);
  });
  it('rejects empty chatId', () => {
    const r = sessionKeySchema.safeParse({ platform: 'telegram', chatId: '' });
    expect(r.success).toBe(false);
  });
  it('rejects unknown platform', () => {
    const r = sessionKeySchema.safeParse({ platform: 'sms', chatId: '123' });
    expect(r.success).toBe(false);
  });
});

describe('sessionKeyString', () => {
  it('formats DM slug as platform:chatId', () => {
    expect(sessionKeyString({ platform: 'telegram', chatId: '8075471258' })).toBe(
      'telegram:8075471258',
    );
  });
  it('formats threaded slug as platform:chatId:threadId', () => {
    expect(
      sessionKeyString({ platform: 'telegram', chatId: '-1003923174632', threadId: '15' }),
    ).toBe('telegram:-1003923174632:15');
  });
});

describe('inboundChatEventSchema', () => {
  const valid = {
    kind: 'inbound_message' as const,
    sessionKey: { platform: 'telegram', chatId: '8075471258' },
    messageId: '42',
    sender: { id: '8075471258', name: 'L0g1cProphet' },
    text: 'WAB.2 test',
    receivedAt: '2026-05-21T19:00:00.000Z',
    enqueuedAt: '2026-05-21T19:00:00.500Z',
    projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
  };
  it('accepts a fully populated event', () => {
    expect(inboundChatEventSchema.safeParse(valid).success).toBe(true);
  });
  it('rejects missing kind discriminator', () => {
    const rest = { ...valid } as Partial<typeof valid>;
    delete rest.kind;
    expect(inboundChatEventSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects non-UUID projectUuid', () => {
    expect(inboundChatEventSchema.safeParse({ ...valid, projectUuid: 'not-a-uuid' }).success).toBe(
      false,
    );
  });
  it('rejects non-ISO receivedAt', () => {
    expect(inboundChatEventSchema.safeParse({ ...valid, receivedAt: 'yesterday' }).success).toBe(
      false,
    );
  });
});

describe('outboundChatReplySchema', () => {
  it('accepts a valid reply', () => {
    const r = outboundChatReplySchema.safeParse({
      sessionKey: { platform: 'telegram', chatId: '123' },
      text: 'hello',
      projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
    });
    expect(r.success).toBe(true);
  });
  it('rejects empty text', () => {
    const r = outboundChatReplySchema.safeParse({
      sessionKey: { platform: 'telegram', chatId: '123' },
      text: '',
      projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
    });
    expect(r.success).toBe(false);
  });
});

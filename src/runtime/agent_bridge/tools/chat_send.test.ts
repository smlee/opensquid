/**
 * agent_bridge tools — chat_send unit tests (WAB.6, 0.5.100).
 *
 * Coverage:
 *   - validator rejects empty text + missing text
 *   - handler defaults `channel` to `project:<platform>` from sessionKey
 *   - handler honors explicit `channel` override
 *   - handler forwards `threadId` when sessionKey carries one
 *   - handler propagates daemon-RPC failures (caller's agent loop turns
 *     them into tool_result strings)
 *
 * Mocking: the `defaultDaemonSend` path opens a UDS socket. We never call
 * it — every test injects a stub `DaemonSendFn` via `makeChatSendHandler`.
 * The default path is exercised by an end-to-end smoke test outside this
 * suite when the daemon is actually running.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  chatSendSpec,
  makeChatSendHandler,
  type DaemonSendFn,
  type DaemonSendParams,
} from './chat_send.js';
import type { ToolContext } from '../types.js';

const CTX: ToolContext = {
  sessionKey: { platform: 'telegram', chatId: '8075471258' },
  projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
};

const CTX_WITH_THREAD: ToolContext = {
  sessionKey: { platform: 'telegram', chatId: '8075471258', threadId: '42' },
  projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
};

function fakeOk(): { ok: true; platform: string; message_id: string; delivered_at: string } {
  return {
    ok: true,
    platform: 'telegram',
    message_id: 'fake-msg-1',
    delivered_at: '2026-05-21T20:00:00.000Z',
  };
}

describe('chat_send.spec', () => {
  it('declares the required input_schema fields', () => {
    expect(chatSendSpec.name).toBe('chat_send');
    expect(chatSendSpec.input_schema).toMatchObject({
      type: 'object',
      required: ['text'],
      additionalProperties: false,
    });
  });

  it('validator rejects empty text', () => {
    expect(() => chatSendSpec.validate?.({ text: '' })).toThrow();
  });

  it('validator rejects missing text', () => {
    expect(() => chatSendSpec.validate?.({})).toThrow();
  });
});

describe('makeChatSendHandler', () => {
  it('defaults channel to project:<platform> when the model omits it', async () => {
    const sends: DaemonSendParams[] = [];
    const stub: DaemonSendFn = (params) => {
      sends.push(params);
      return Promise.resolve(fakeOk());
    };
    const handler = makeChatSendHandler(stub);
    const validated = chatSendSpec.validate!({ text: 'hello' });
    const out = await handler(validated, CTX);
    expect(sends).toEqual([{ channel: 'project:telegram', text: 'hello' }]);
    expect(out).toMatch(/sent ok/);
    expect(out).toMatch(/message_id=fake-msg-1/);
  });

  it('honors an explicit channel override', async () => {
    const stub = vi.fn((_params: DaemonSendParams) => Promise.resolve(fakeOk()));
    const handler = makeChatSendHandler(stub);
    const validated = chatSendSpec.validate!({
      text: 'cross-post',
      channel: 'telegram:-123456/789',
    });
    await handler(validated, CTX);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]?.[0]).toMatchObject({
      channel: 'telegram:-123456/789',
      text: 'cross-post',
    });
  });

  it('forwards threadId when the session key carries one', async () => {
    const sends: DaemonSendParams[] = [];
    const stub: DaemonSendFn = (params) => {
      sends.push(params);
      return Promise.resolve(fakeOk());
    };
    const handler = makeChatSendHandler(stub);
    const validated = chatSendSpec.validate!({ text: 'in-thread' });
    await handler(validated, CTX_WITH_THREAD);
    expect(sends[0]?.threadId).toBe('42');
  });

  it('propagates daemon RPC failures verbatim', async () => {
    const stub: DaemonSendFn = () => Promise.reject(new Error('daemon down'));
    const handler = makeChatSendHandler(stub);
    const validated = chatSendSpec.validate!({ text: 'ping' });
    await expect(handler(validated, CTX)).rejects.toThrow(/daemon down/);
  });
});

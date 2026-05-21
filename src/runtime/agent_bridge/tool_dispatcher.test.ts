/**
 * agent_bridge — SimpleToolDispatcher unit tests (WAB.4, 0.5.97).
 *
 * Fixtures cover:
 *   - register + list preserves insertion order
 *   - duplicate name → throws
 *   - call(unknown) → throws with available-tool list
 *   - call(known, valid) → validator runs, result forwarded
 *   - call(known, invalid) → validator throws, handler never invoked
 *   - call without validator → input passed through to handler
 *   - handler async rejection surfaces unmodified
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { SimpleToolDispatcher } from './tool_dispatcher.js';
import type { ToolHandler, ToolSpec } from './types.js';

const CTX = {
  sessionKey: { platform: 'telegram' as const, chatId: '8075471258' },
  projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
};

function passthroughTool(name: string): { spec: ToolSpec; handler: ToolHandler } {
  return {
    spec: {
      name,
      description: `passthrough ${name}`,
      input_schema: { type: 'object', properties: {} },
    },
    handler: (input) => Promise.resolve(JSON.stringify(input)),
  };
}

describe('SimpleToolDispatcher.register + list', () => {
  it('preserves insertion order in list()', () => {
    const d = new SimpleToolDispatcher();
    d.register(passthroughTool('a'));
    d.register(passthroughTool('c'));
    d.register(passthroughTool('b'));
    expect(d.list().map((s) => s.name)).toEqual(['a', 'c', 'b']);
  });

  it('accepts an initial registration array', () => {
    const d = new SimpleToolDispatcher([passthroughTool('x'), passthroughTool('y')]);
    expect(d.size).toBe(2);
    expect(d.has('x')).toBe(true);
    expect(d.has('y')).toBe(true);
    expect(d.has('z')).toBe(false);
  });

  it('throws on duplicate name', () => {
    const d = new SimpleToolDispatcher([passthroughTool('a')]);
    expect(() => d.register(passthroughTool('a'))).toThrow(/duplicate tool name 'a'/);
  });
});

describe('SimpleToolDispatcher.call', () => {
  it('throws on unknown tool name including the registered list', async () => {
    const d = new SimpleToolDispatcher([passthroughTool('chat_send')]);
    await expect(d.call('recall', {}, CTX)).rejects.toThrow(
      /unknown tool 'recall'.*registered: \[chat_send\]/,
    );
  });

  it('invokes the handler with raw input when no validator is declared', async () => {
    const captured: unknown[] = [];
    const handler: ToolHandler = (input) => {
      captured.push(input);
      return Promise.resolve('ok');
    };
    const d = new SimpleToolDispatcher([
      {
        spec: { name: 'echo', description: 'd', input_schema: {} },
        handler,
      },
    ]);
    const result = await d.call('echo', { foo: 1 }, CTX);
    expect(result).toBe('ok');
    expect(captured).toEqual([{ foo: 1 }]);
  });

  it('runs the validator before the handler and forwards its return value', async () => {
    const schema = z.object({ text: z.string().min(1) });
    const handler = vi.fn((input: unknown) => {
      const narrowed = input as { text: string };
      return Promise.resolve(`received: ${narrowed.text}`);
    });
    const d = new SimpleToolDispatcher([
      {
        spec: {
          name: 'send',
          description: 'd',
          input_schema: {},
          validate: (input) => schema.parse(input),
        },
        handler,
      },
    ]);
    const result = await d.call('send', { text: 'hello' }, CTX);
    expect(result).toBe('received: hello');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ text: 'hello' }, CTX);
  });

  it('throws (and skips the handler) when the validator rejects', async () => {
    const schema = z.object({ text: z.string().min(1) });
    const handler = vi.fn(() => Promise.resolve('should-not-fire'));
    const d = new SimpleToolDispatcher([
      {
        spec: {
          name: 'send',
          description: 'd',
          input_schema: {},
          validate: (input) => schema.parse(input),
        },
        handler,
      },
    ]);
    await expect(d.call('send', { text: '' }, CTX)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it('surfaces handler async rejections unmodified', async () => {
    const d = new SimpleToolDispatcher([
      {
        spec: { name: 'boom', description: 'd', input_schema: {} },
        handler: () => Promise.reject(new Error('handler exploded')),
      },
    ]);
    await expect(d.call('boom', {}, CTX)).rejects.toThrow(/handler exploded/);
  });

  it('passes the ctx through to the handler', async () => {
    const captured: { sessionKey: unknown; projectUuid: string }[] = [];
    const d = new SimpleToolDispatcher([
      {
        spec: { name: 't', description: 'd', input_schema: {} },
        handler: (_input, ctx) => {
          captured.push(ctx);
          return Promise.resolve('ok');
        },
      },
    ]);
    await d.call('t', {}, CTX);
    expect(captured[0]).toEqual(CTX);
  });
});

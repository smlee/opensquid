/**
 * Tests for mcp strategy.
 *   1. Factory throws synchronously when server or tool is missing
 *      (fail-fast at resolve time, not at first .call()).
 *   2. Mocked client returns text → strategy returns the text content.
 *   3. Multi-call lifecycle: each .call() runs connect → callTool →
 *      close (connect-per-call is acceptable for Phase 1; pooling
 *      deferred).
 */

import { describe, expect, it, vi } from 'vitest';

import type { ModelAliasConfig } from '../types.js';

import { mcpStrategy, type McpClientLike } from './mcp.js';

const cfg: ModelAliasConfig = {
  mode: 'mcp',
  server: 'some-mcp-binary',
  tool: 'generate',
  args: [],
};

function makeStubClient(textOut: string): { client: McpClientLike; calls: string[] } {
  const calls: string[] = [];
  const client: McpClientLike = {
    connect: vi.fn((_transport: unknown) => {
      calls.push('connect');
      return Promise.resolve();
    }),
    callTool: vi.fn((req: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(`callTool:${req.name}`);
      return Promise.resolve({ content: [{ type: 'text', text: textOut }] });
    }),
    close: vi.fn(() => {
      calls.push('close');
      return Promise.resolve();
    }),
  };
  return { client, calls };
}

describe('mcpStrategy', () => {
  it('throws at factory time when server is missing', () => {
    expect(() => mcpStrategy({ mode: 'mcp', tool: 'generate' })).toThrow(/`server` is required/);
  });

  it('throws at factory time when tool is missing', () => {
    expect(() => mcpStrategy({ mode: 'mcp', server: 'bin' })).toThrow(/`tool` is required/);
  });

  it('returns the first text block from the tool result', async () => {
    const { client } = makeStubClient('hello from mcp');
    const strat = mcpStrategy(cfg, {
      clientFactory: () => Promise.resolve({ client, transport: {} }),
    });
    const out = await strat.call('hi');
    expect(out).toBe('hello from mcp');
  });

  it('runs connect → callTool → close for each call', async () => {
    const { client, calls } = makeStubClient('ok');
    const strat = mcpStrategy(cfg, {
      clientFactory: () => Promise.resolve({ client, transport: {} }),
    });
    await strat.call('a');
    await strat.call('b');
    // Two full lifecycles, each connect → callTool → close.
    expect(calls).toEqual([
      'connect',
      'callTool:generate',
      'close',
      'connect',
      'callTool:generate',
      'close',
    ]);
  });
});

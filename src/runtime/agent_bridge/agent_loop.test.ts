/**
 * agent_bridge — runAgentTurn unit tests (WAB.4, 0.5.97).
 *
 * Fixtures aligned with the WAB.4 spec's 7-test plan:
 *   1. single-turn text response → returns replyText, no tool calls
 *   2. tool_use stop_reason → dispatcher.call invoked → tool_result fed
 *      back → terminal response returned
 *   3. cache_control markers present on system + last 2 user messages,
 *      NOT on older ones
 *   4. MAX_TOOL_ITERATIONS exceeded → throws explicit error
 *   5-6. (covered in tool_dispatcher.test.ts: unknown name + invalid args)
 *   7. LIVE (gated by WAB_AGENT_LOOP_LIVE=1 + ANTHROPIC_API_KEY): real
 *      Anthropic call with `claude-haiku-4-5-...` + no-op tool — skipped
 *      in CI because the key isn't in ~/.loop/.env on the user's box.
 *
 * Mock pattern: structural stub of `AnthropicMessageClient` (the
 * structural contract owned by agent_loop.ts). No `vi.mock` of the SDK
 * module needed — runAgentTurn takes the client through opts.client.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CACHE_BREAKPOINT_USER_MSGS,
  DEFAULT_MAX_TOKENS,
  MAX_TOOL_ITERATIONS,
  runAgentTurn,
  type AnthropicMessageClient,
  type AnthropicMessageCreateParams,
  type AnthropicMessageResponse,
} from './agent_loop.js';
import { SimpleToolDispatcher } from './tool_dispatcher.js';
import type { ChatHistoryEntry, SessionState, ToolHandler, ToolSpec } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    key: { platform: 'telegram', chatId: '8075471258' },
    history: [],
    lastActivityMs: 0,
    projectUuid: '0742f358-c0fd-4690-ae9d-da8f4102ab4a',
    packId: 'default',
    modelAlias: 'fast_chat',
    turnInFlight: false,
    ...overrides,
  };
}

function userMsg(text: string): ChatHistoryEntry {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: '2026-05-21T19:00:00.000Z',
  };
}

function assistantText(text: string): ChatHistoryEntry {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: '2026-05-21T19:00:01.000Z',
  };
}

function stubClient(responses: AnthropicMessageResponse[]): {
  client: AnthropicMessageClient;
  requests: AnthropicMessageCreateParams[];
} {
  const requests: AnthropicMessageCreateParams[] = [];
  let i = 0;
  const client: AnthropicMessageClient = {
    create: (params) => {
      requests.push(params);
      const next = responses[i++];
      if (next === undefined) {
        return Promise.reject(new Error(`stub: no response queued (call #${i})`));
      }
      return Promise.resolve(next);
    },
  };
  return { client, requests };
}

function echoSpec(name: string): ToolSpec {
  return {
    name,
    description: `echo ${name}`,
    input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
  };
}

const ECHO_HANDLER: ToolHandler = (input) => Promise.resolve(`echoed:${JSON.stringify(input)}`);

// ---------------------------------------------------------------------------
// Tunable sanity
// ---------------------------------------------------------------------------

describe('agent_loop tunables', () => {
  it('exports the locked WAB.4 constants', () => {
    expect(MAX_TOOL_ITERATIONS).toBe(8);
    expect(DEFAULT_MAX_TOKENS).toBe(1024);
    expect(CACHE_BREAKPOINT_USER_MSGS).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Single-turn text response
// ---------------------------------------------------------------------------

describe('runAgentTurn — text-only single turn', () => {
  it('returns replyText + new entries; no tool dispatch', async () => {
    const { client, requests } = stubClient([
      {
        content: [{ type: 'text', text: 'hi there' }],
        stop_reason: 'end_turn',
      },
    ]);
    const dispatcher = new SimpleToolDispatcher();
    const state = freshState();

    const { assistantEntries, replyText } = await runAgentTurn(state, 'hello', {
      client,
      model: 'test-model-x',
      systemPrompt: 'be terse',
      tools: dispatcher.list(),
      dispatcher,
    });

    expect(replyText).toBe('hi there');
    expect(requests).toHaveLength(1);
    // Returned entries: inbound user msg + assistant reply.
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[0]?.role).toBe('user');
    expect(assistantEntries[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(assistantEntries[1]?.role).toBe('assistant');
    expect(assistantEntries[1]?.content).toEqual([{ type: 'text', text: 'hi there' }]);
    // State must NOT have been mutated — caller's SessionManager.appendTurn does that.
    expect(state.history).toEqual([]);
  });

  it('joins multiple text blocks in the reply', async () => {
    const { client } = stubClient([
      {
        content: [
          { type: 'text', text: 'first line' },
          { type: 'text', text: 'second line' },
        ],
        stop_reason: 'end_turn',
      },
    ]);
    const dispatcher = new SimpleToolDispatcher();
    const { replyText } = await runAgentTurn(freshState(), 'hi', {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: [],
      dispatcher,
    });
    expect(replyText).toBe('first line\nsecond line');
  });
});

// ---------------------------------------------------------------------------
// Tool-use round-trip
// ---------------------------------------------------------------------------

describe('runAgentTurn — tool_use loop', () => {
  it('dispatches tool_use blocks, feeds tool_result back, returns terminal text', async () => {
    const { client, requests } = stubClient([
      {
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu_1', name: 'echo', input: { msg: 'ping' } },
        ],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'done — ping echoed' }],
        stop_reason: 'end_turn',
      },
    ]);
    const dispatcher = new SimpleToolDispatcher([
      { spec: echoSpec('echo'), handler: ECHO_HANDLER },
    ]);

    const { assistantEntries, replyText } = await runAgentTurn(freshState(), 'echo ping', {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: dispatcher.list(),
      dispatcher,
    });

    expect(replyText).toBe('done — ping echoed');
    expect(requests).toHaveLength(2);

    // Second request must include the tool_result the dispatcher produced.
    const secondReq = requests[1]!;
    const toolResultMsg = secondReq.messages.find(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
    const trBlock = toolResultMsg!.content.find((b) => b.type === 'tool_result');
    expect(trBlock).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'echoed:{"msg":"ping"}',
    });

    // Returned entries: inbound user + assistant (text+tool_use) + tool_result (user role) + final assistant.
    expect(assistantEntries).toHaveLength(4);
    expect(assistantEntries[2]?.role).toBe('user');
    expect(assistantEntries[2]?.content[0]?.type).toBe('tool_result');
  });

  it('surfaces dispatcher errors back as tool_result (recoverable failure path)', async () => {
    const { client, requests } = stubClient([
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'broken', input: {} }],
        stop_reason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'sorry, that failed' }],
        stop_reason: 'end_turn',
      },
    ]);
    const dispatcher = new SimpleToolDispatcher([
      {
        spec: echoSpec('broken'),
        handler: () => Promise.reject(new Error('bad')),
      },
    ]);
    const { replyText } = await runAgentTurn(freshState(), 'go', {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: dispatcher.list(),
      dispatcher,
    });
    expect(replyText).toBe('sorry, that failed');
    const trBlock = requests[1]!.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result');
    expect(trBlock).toMatchObject({ content: 'tool error: bad' });
  });
});

// ---------------------------------------------------------------------------
// Cache marker placement
// ---------------------------------------------------------------------------

describe('runAgentTurn — cache_control marker placement', () => {
  it('marks system prompt and last 2 user messages, NOT older ones', async () => {
    const { client, requests } = stubClient([
      { content: [{ type: 'text', text: 'ack' }], stop_reason: 'end_turn' },
    ]);
    const dispatcher = new SimpleToolDispatcher();
    const state = freshState({
      history: [
        userMsg('msg-1 (oldest)'),
        assistantText('reply-1'),
        userMsg('msg-2'),
        assistantText('reply-2'),
        userMsg('msg-3 (prev turn)'),
        assistantText('reply-3'),
      ],
    });

    await runAgentTurn(state, 'msg-4 (current)', {
      client,
      model: 'm',
      systemPrompt: 'be brief',
      tools: [],
      dispatcher,
    });

    const req = requests[0]!;

    // System prompt: marked.
    expect(req.system).toHaveLength(1);
    expect(req.system[0]?.cache_control).toEqual({ type: 'ephemeral' });

    // User messages in order: msg-1, msg-2, msg-3, msg-4 (current).
    // Marker policy = last 2 → msg-3 + msg-4 marked, msg-1 + msg-2 not.
    const userMsgsInReq = req.messages.filter((m) => m.role === 'user');
    expect(userMsgsInReq).toHaveLength(4);
    const lastBlockCC = (m: (typeof userMsgsInReq)[number]) =>
      m.content[m.content.length - 1]?.cache_control;
    expect(lastBlockCC(userMsgsInReq[0]!)).toBeUndefined(); // msg-1
    expect(lastBlockCC(userMsgsInReq[1]!)).toBeUndefined(); // msg-2
    expect(lastBlockCC(userMsgsInReq[2]!)).toEqual({ type: 'ephemeral' }); // msg-3
    expect(lastBlockCC(userMsgsInReq[3]!)).toEqual({ type: 'ephemeral' }); // msg-4 (current)
  });

  it('marks only the inbound message when history is empty (single user msg)', async () => {
    const { client, requests } = stubClient([
      { content: [{ type: 'text', text: 'ack' }], stop_reason: 'end_turn' },
    ]);
    const dispatcher = new SimpleToolDispatcher();
    await runAgentTurn(freshState(), 'hello', {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: [],
      dispatcher,
    });
    const userMsgs = requests[0]!.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]!.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

// ---------------------------------------------------------------------------
// Iteration cap
// ---------------------------------------------------------------------------

describe('runAgentTurn — MAX_TOOL_ITERATIONS guard', () => {
  it('throws explicit error when the model loops past the cap', async () => {
    // Build N+1 responses that all stay in tool_use; the loop should
    // throw on iteration N.
    const cap = 3;
    const responses: AnthropicMessageResponse[] = Array.from({ length: cap + 2 }, (_, i) => ({
      content: [{ type: 'tool_use', id: `tu_${i}`, name: 'echo', input: { i } }],
      stop_reason: 'tool_use' as const,
    }));
    const { client } = stubClient(responses);
    const dispatcher = new SimpleToolDispatcher([
      { spec: echoSpec('echo'), handler: ECHO_HANDLER },
    ]);

    await expect(
      runAgentTurn(freshState(), 'loop forever', {
        client,
        model: 'm',
        systemPrompt: 's',
        tools: dispatcher.list(),
        dispatcher,
        maxToolIterations: cap,
      }),
    ).rejects.toThrow(/exceeded MAX_TOOL_ITERATIONS=3/);
  });
});

// ---------------------------------------------------------------------------
// Injected timestamps + custom maxTokens
// ---------------------------------------------------------------------------

describe('runAgentTurn — options surface', () => {
  it('uses nowIso for entry timestamps when provided', async () => {
    const { client } = stubClient([
      { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
    ]);
    const fixed = vi.fn(() => '2030-01-01T00:00:00.000Z');
    const dispatcher = new SimpleToolDispatcher();
    const { assistantEntries } = await runAgentTurn(freshState(), 'x', {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: [],
      dispatcher,
      nowIso: fixed,
    });
    for (const e of assistantEntries) {
      expect(e.timestamp).toBe('2030-01-01T00:00:00.000Z');
    }
    expect(fixed).toHaveBeenCalled();
  });

  it('forwards custom maxTokens to the SDK call', async () => {
    const { client, requests } = stubClient([
      { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' },
    ]);
    const dispatcher = new SimpleToolDispatcher();
    await runAgentTurn(freshState(), 'x', {
      client,
      model: 'm',
      systemPrompt: 's',
      tools: [],
      dispatcher,
      maxTokens: 2048,
    });
    expect(requests[0]?.max_tokens).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// Live (gated)
//
// Skipped unless WAB_AGENT_LOOP_LIVE=1 + ANTHROPIC_API_KEY are set.
// The key is NOT in ~/.loop/.env on the user's box (verified during
// WAB.4 pre-research) so this defaults to skipped in CI + local runs.
// ---------------------------------------------------------------------------

const LIVE_ENABLED =
  process.env.WAB_AGENT_LOOP_LIVE === '1' &&
  typeof process.env.ANTHROPIC_API_KEY === 'string' &&
  process.env.ANTHROPIC_API_KEY.length > 0;

describe.skipIf(!LIVE_ENABLED)('runAgentTurn — live Anthropic round-trip', () => {
  it('completes a text-only turn within 10s using a real haiku model', async () => {
    // Dynamic import so the package isn't required in non-live runs.
    const sdkModule = (await import('@anthropic-ai/sdk')) as unknown as {
      default: new (opts: { apiKey: string }) => {
        messages: AnthropicMessageClient;
      };
    };
    const client = new sdkModule.default({
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });
    const dispatcher = new SimpleToolDispatcher();

    const start = Date.now();
    const { replyText } = await runAgentTurn(freshState(), 'Say "pong" and nothing else.', {
      client: client.messages,
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'Reply with one short word.',
      tools: [],
      dispatcher,
      maxTokens: 16,
    });
    const elapsedMs = Date.now() - start;

    expect(replyText.toLowerCase()).toContain('pong');
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});

/**
 * agent_bridge — ChatDispatcher unit tests (WAB.5, 0.5.99).
 *
 * Fixtures aligned with WAB.5 spec test plan:
 *   - inbound event → batch coalesces → agent loop invoked once with
 *     coalesced text → reply forwarded via onReply
 *   - per-session mutex — if turn in flight, new batch BUFFERS until
 *     previous completes; result is a SECOND agent turn (not interleaved)
 *   - per-session mutex bound — third distinct flush attempt while in-
 *     flight + queue full → DROP with onWarn
 *   - two distinct sessions can run agent turns concurrently (mutex is
 *     PER-session, not global)
 *   - failure in runAgentTurn surfaces via onTurnError + clears
 *     turnInFlight so the next flush can proceed
 *   - shutdown awaits in-flight turns + drops queued batches
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type AnthropicMessageClient,
  type AnthropicMessageCreateParams,
  type AnthropicMessageResponse,
} from './agent_loop.js';
import { ChatDispatcher } from './dispatcher.js';
import { AgentEventBus } from './event_bus.js';
import { headlessSessionId } from './headless_lease.js';
import { SessionManager } from './session_manager.js';
import { SessionPersistence } from './session_persistence.js';
import type { InboundChatEvent, SessionKey, ToolDispatcher } from './types.js';
import { writeLease } from '../chat/live_session_lease.js';
import { umbrellaLiveSessionLease } from '../paths.js';

const PROJECT_UUID = '0742f358-c0fd-4690-ae9d-da8f4102ab4a';
const KEY: SessionKey = { platform: 'telegram', chatId: '8075471258' };
const OTHER_KEY: SessionKey = { platform: 'telegram', chatId: '9000000000' };

interface ClientCall {
  request: AnthropicMessageCreateParams;
  replyText: string;
}

let tmpRoot: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'wab5-dp-'));
  // Isolate the default live-session-lease check (DEL.2) from the real
  // ~/.opensquid — an empty tmp home means "no live session" → daemon responds,
  // preserving the existing tests' expectations.
  savedHome = process.env.OPENSQUID_HOME;
  process.env.OPENSQUID_HOME = tmpRoot;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENSQUID_HOME;
  else process.env.OPENSQUID_HOME = savedHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeManager(): SessionManager {
  return new SessionManager({
    persistence: new SessionPersistence({ root: tmpRoot }),
    defaultPackId: 'default',
    defaultModelAlias: 'fast_chat',
  });
}

/** Build a stub client whose `create` returns the next queued reply. */
function makeClient(replies: string[], calls: ClientCall[] = []): AnthropicMessageClient {
  let i = 0;
  return {
    create: (request) => {
      const replyText = replies[i] ?? 'default';
      i += 1;
      calls.push({ request, replyText });
      const response: AnthropicMessageResponse = {
        content: [{ type: 'text', text: replyText }],
        stop_reason: 'end_turn',
      };
      return Promise.resolve(response);
    },
  };
}

/** Same as makeClient but each create call waits for an external trigger
 *  before resolving. Lets tests start a turn, observe in-flight state,
 *  then release. */
function makeGatedClient(replies: string[]): {
  client: AnthropicMessageClient;
  release: (idx: number) => void;
  calls: ClientCall[];
} {
  const calls: ClientCall[] = [];
  const gates: (() => void)[] = [];
  let i = 0;
  const client: AnthropicMessageClient = {
    create: async (request) => {
      const myIdx = i;
      const replyText = replies[myIdx] ?? 'default';
      i += 1;
      calls.push({ request, replyText });
      await new Promise<void>((resolve) => {
        gates[myIdx] = resolve;
      });
      const response: AnthropicMessageResponse = {
        content: [{ type: 'text', text: replyText }],
        stop_reason: 'end_turn',
      };
      return response;
    },
  };
  return {
    client,
    release: (idx) => {
      const g = gates[idx];
      if (g !== undefined) g();
    },
    calls,
  };
}

const NOOP_TOOLS: ToolDispatcher = {
  list: () => [],
  call: () => Promise.resolve('unused'),
};

function fixtureEvent(key: SessionKey, text: string, id = '1'): InboundChatEvent {
  return {
    kind: 'inbound_message',
    sessionKey: key,
    messageId: id,
    sender: { id: key.chatId, name: 'L0g1cProphet' },
    text,
    receivedAt: '2026-05-21T19:00:00.000Z',
    enqueuedAt: '2026-05-21T19:00:00.001Z',
    projectUuid: PROJECT_UUID,
  };
}

/** Yield to the microtask queue until queued promise chains settle.
 *  Needed because BatchCoordinator's flush is `async` and the chain
 *  hops await boundaries before the dispatcher's state stabilizes. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('ChatDispatcher — basic flow', () => {
  // Real timers throughout: the chain hops real I/O (fs.appendFile in
  // SessionPersistence) which doesn't compose cleanly with fake timers.
  // We use the batchOptions override to drop the delay to 1ms so the
  // suite stays fast.

  it('coalesces multiple inbound events into one agent turn', async () => {
    const sm = makeManager();
    // Pre-create the session so projectUuid resolution succeeds.
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['hello back'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'claude-haiku-test',
        systemPrompt: 'you are a test agent',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'hi', '1'));
    bus.emit('inbound', fixtureEvent(KEY, 'there', '2'));

    // Wait for batch flush + turn + persistence + onReply chain to settle.
    await new Promise((r) => setTimeout(r, 100));
    await drain();

    expect(calls).toHaveLength(1);
    const messages = calls[0]?.request.messages;
    expect(messages).toBeDefined();
    const lastUser = messages?.[messages.length - 1];
    expect(lastUser?.content[0]).toMatchObject({ type: 'text', text: 'hi\nthere' });
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('hello back');

    await dp.shutdown();
    sm.shutdown();
  });

  it('runs two distinct sessions concurrently (mutex is per-session)', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    await sm.getOrCreate(OTHER_KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['reply-a', 'reply-b'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'claude-haiku-test',
        systemPrompt: 'sys',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'first', '1'));
    bus.emit('inbound', fixtureEvent(OTHER_KEY, 'second', '2'));
    await new Promise((r) => setTimeout(r, 100));
    await drain();

    expect(calls).toHaveLength(2);
    expect(replies).toHaveLength(2);
    const texts = replies.map((r) => r.text).sort();
    expect(texts).toEqual(['reply-a', 'reply-b']);

    await dp.shutdown();
    sm.shutdown();
  });
});

describe('ChatDispatcher — per-session mutex + queue', () => {
  // Real timers here — the gated-client pattern wants real
  // microtasks; fake-timer interleaving with async-trigger gates gets
  // hairy.

  it('buffers a second batch while the first turn is in flight', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const gated = makeGatedClient(['first-reply', 'second-reply']);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client: gated.client,
        model: 'claude-haiku-test',
        systemPrompt: 'sys',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      // Use a very short delay so the batch flushes immediately
      // for the test's purposes.
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'turn-1', '1'));
    // Wait for the batch to flush + the first turn to enter the gated
    // client.
    await new Promise((r) => setTimeout(r, 100));
    expect(gated.calls).toHaveLength(1);
    expect(dp.inFlightTurnCount).toBe(1);

    // While the first turn is hanging on the gate, emit a second
    // event for the SAME session. The batch coalesces and flushes,
    // but the dispatcher should QUEUE instead of starting a second
    // turn concurrently.
    bus.emit('inbound', fixtureEvent(KEY, 'turn-2', '2'));
    await new Promise((r) => setTimeout(r, 100));
    expect(gated.calls).toHaveLength(1); // still only the first
    expect(dp.queuedTurnCount).toBe(1);

    // Release the first turn — the dispatcher should drain the queue
    // and start the second turn.
    gated.release(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(gated.calls).toHaveLength(2);
    // The second turn's user content should be 'turn-2'.
    const secondMessages = gated.calls[1]?.request.messages;
    const secondLast = secondMessages?.[secondMessages.length - 1];
    expect(secondLast?.content[0]).toMatchObject({ type: 'text', text: 'turn-2' });
    expect(dp.queuedTurnCount).toBe(0);

    // Release the second turn so shutdown can proceed.
    gated.release(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(replies).toHaveLength(2);

    await dp.shutdown();
    sm.shutdown();
  });

  it('coalesces a second queued batch instead of dropping (attempt 2)', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const gated = makeGatedClient(['r1', 'r2']);
    const bus = new AgentEventBus();
    const warns: string[] = [];
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client: gated.client,
        model: 'claude-haiku-test',
        systemPrompt: 'sys',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onWarn: (m) => warns.push(m),
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'turn-1', '1'));
    await new Promise((r) => setTimeout(r, 100));
    expect(gated.calls).toHaveLength(1);
    expect(dp.inFlightTurnCount).toBe(1);

    // Second batch enqueues (attempt 1 fills the slot).
    bus.emit('inbound', fixtureEvent(KEY, 'queue-a', '2'));
    await new Promise((r) => setTimeout(r, 100));
    expect(dp.queuedTurnCount).toBe(1);

    // Third batch coalesces into the queue slot (attempt 2). Still 1
    // queued, no warn yet.
    bus.emit('inbound', fixtureEvent(KEY, 'queue-b', '3'));
    await new Promise((r) => setTimeout(r, 100));
    expect(dp.queuedTurnCount).toBe(1);
    expect(warns).toHaveLength(0);

    gated.release(0);
    await new Promise((r) => setTimeout(r, 100));

    // Second turn should receive the coalesced queue text.
    expect(gated.calls).toHaveLength(2);
    const secondMessages = gated.calls[1]?.request.messages;
    const secondLast = secondMessages?.[secondMessages.length - 1];
    expect(secondLast?.content[0]).toMatchObject({ type: 'text', text: 'queue-a\nqueue-b' });

    gated.release(1);
    await new Promise((r) => setTimeout(r, 100));

    await dp.shutdown();
    sm.shutdown();
  });

  it('drops the THIRD distinct flush attempt while queue is full', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const gated = makeGatedClient(['r1', 'r2']);
    const bus = new AgentEventBus();
    const warns: string[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client: gated.client,
        model: 'claude-haiku-test',
        systemPrompt: 'sys',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onWarn: (m) => warns.push(m),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'turn-1', '1'));
    await new Promise((r) => setTimeout(r, 100));
    bus.emit('inbound', fixtureEvent(KEY, 'queue-1', '2'));
    await new Promise((r) => setTimeout(r, 100));
    bus.emit('inbound', fixtureEvent(KEY, 'queue-2', '3'));
    await new Promise((r) => setTimeout(r, 100));
    // Third distinct flush — the dispatcher coalesces into the queue
    // slot but DOES NOT warn yet (attempt 2 is the coalesce cap).
    bus.emit('inbound', fixtureEvent(KEY, 'dropme', '4'));
    await new Promise((r) => setTimeout(r, 100));
    // Now we're at attempt 3 → DROP + warn.
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((w) => w.includes('dropping batch'))).toBe(true);
    expect(warns.some((w) => w.includes('telegram:8075471258'))).toBe(true);

    gated.release(0);
    await new Promise((r) => setTimeout(r, 100));
    gated.release(1);
    await new Promise((r) => setTimeout(r, 100));

    await dp.shutdown();
    sm.shutdown();
  });
});

describe('ChatDispatcher — failure surface', () => {
  it('surfaces agent-turn failure via onTurnError + clears turnInFlight', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const client: AnthropicMessageClient = {
      create: () => Promise.reject(new Error('upstream 500')),
    };
    const bus = new AgentEventBus();
    const warns: string[] = [];
    const errors: unknown[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'claude-haiku-test',
        systemPrompt: 'sys',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onWarn: (m) => warns.push(m),
      onTurnError: (_k, e) => errors.push(e),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'failing turn', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('upstream 500');
    // turnInFlight must be cleared so the next flush can proceed.
    expect(sm.peek(KEY)?.turnInFlight).toBe(false);
    expect(dp.inFlightTurnCount).toBe(0);

    await dp.shutdown();
    sm.shutdown();
  });
});

describe('ChatDispatcher — lifecycle', () => {
  it('shutdown awaits in-flight turns + drops queued', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const gated = makeGatedClient(['r1', 'r2']);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client: gated.client,
        model: 'claude-haiku-test',
        systemPrompt: 'sys',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'in-flight', '1'));
    await new Promise((r) => setTimeout(r, 100));
    bus.emit('inbound', fixtureEvent(KEY, 'queued', '2'));
    await new Promise((r) => setTimeout(r, 100));
    expect(dp.queuedTurnCount).toBe(1);

    // Begin shutdown — it should resolve only after the in-flight
    // turn settles. We release the gate from inside a deferred
    // task so shutdown's await is real.
    const shutdownPromise = dp.shutdown();
    setTimeout(() => gated.release(0), 10);
    await shutdownPromise;

    // Only one turn ran (the in-flight one); the queued one was
    // dropped by shutdown.
    expect(gated.calls).toHaveLength(1);
    expect(replies).toHaveLength(1);

    sm.shutdown();
  });

  it('start is idempotent and shutdown is idempotent', async () => {
    const sm = makeManager();
    const client = makeClient([]);
    const bus = new AgentEventBus();
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
    });
    dp.start();
    dp.start();
    // Bus only has one listener registered.
    expect(bus.listenerCount('inbound')).toBe(1);
    await dp.shutdown();
    await dp.shutdown();
    expect(bus.listenerCount('inbound')).toBe(0);
    sm.shutdown();
  });

  it('throws on restart after shutdown', async () => {
    const sm = makeManager();
    const client = makeClient([]);
    const bus = new AgentEventBus();
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
    });
    dp.start();
    await dp.shutdown();
    expect(() => dp.start()).toThrow(/cannot restart/);
    sm.shutdown();
  });
});

describe('ChatDispatcher — subscription mode (WAB-SUB.2)', () => {
  it('dispatches to runAgentTurnSubscription when agentLoopOptions.mode = subscription', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    // Stub ClaudeCliClient — records the run() call + returns canned stdout.
    const cliCalls: { cli: string; args: string[]; stdin: string }[] = [];
    const stubCli = {
      run: (req: { cli: string; args: string[]; stdin: string }) => {
        cliCalls.push({ cli: req.cli, args: req.args, stdin: req.stdin });
        return Promise.resolve('cli reply from claude');
      },
    };
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'subscription',
        cli: 'claude',
        args: ['--print'],
        mcpConfigPath: '/tmp/fake-mcp.json',
        systemPrompt: 'you are tested',
        client: stubCli,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'hello sub', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0]?.cli).toBe('claude');
    // Base args + our runtime layers.
    expect(cliCalls[0]?.args).toContain('--print');
    expect(cliCalls[0]?.args).toContain('--append-system-prompt');
    expect(cliCalls[0]?.args).toContain('--mcp-config');
    expect(cliCalls[0]?.args).toContain('/tmp/fake-mcp.json');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe('cli reply from claude');

    await dp.shutdown();
    sm.shutdown();
  });
});

describe('ChatDispatcher — cross-session arbitration (DEL.2)', () => {
  it('skips the turn when a live session holds the project', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['should not be used'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const skips: { owner: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
      shouldSkipTurn: () => Promise.resolve(true),
      onSkip: (_key, owner) => skips.push({ owner }),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'a live session is handling this', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(calls).toHaveLength(0); // agent loop NOT invoked
    expect(replies).toHaveLength(0); // daemon stayed silent
    expect(skips).toHaveLength(1);
    expect(skips[0]?.owner).toBe(`project=${PROJECT_UUID}`);

    await dp.shutdown();
    sm.shutdown();
  });

  it('responds when no live session is active (lease stale/absent)', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['daemon reply'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
      shouldSkipTurn: () => Promise.resolve(false),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'no live session here', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(calls.length).toBeGreaterThan(0); // agent loop ran
    expect(replies.length).toBeGreaterThan(0);

    await dp.shutdown();
    sm.shutdown();
  });

  it('fails open (responds) when the live-session check throws', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['daemon reply'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      onReply: (key, text) => replies.push({ key, text }),
      shouldSkipTurn: () => Promise.reject(new Error('lease read boom')),
    });
    dp.start();

    bus.emit('inbound', fixtureEvent(KEY, 'check throws', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(calls.length).toBeGreaterThan(0); // throw treated as "no live session"
    expect(replies.length).toBeGreaterThan(0);

    await dp.shutdown();
    sm.shutdown();
  });
});

// ---------------------------------------------------------------------------
// CAT.5 — umbrella-keyed ownership guard (default arbitration). These use the
// REAL defaultShouldSkipTurn (no shouldSkipTurn injection) reading the umbrella
// lease under the test's tmp OPENSQUID_HOME, so they exercise the actual
// double-holder guard. The agent loop is a counting stub → a model call only
// happens when the daemon ANSWERS, proving "no answer" = "no tokens".
// ---------------------------------------------------------------------------

const UMB = 'loop';
const HEADLESS_ID = headlessSessionId(UMB);

function umbrellaEvent(key: SessionKey, text: string, id = '1'): InboundChatEvent {
  return { ...fixtureEvent(key, text, id), umbrellaId: UMB };
}

describe('ChatDispatcher — CAT.5 umbrella ownership guard', () => {
  it('does NOT answer (no agent-loop call) while a fresh HUMAN holds the umbrella lease', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['must not be used'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const skips: { owner: string }[] = [];
    // A human terminal holds a FRESH umbrella lease.
    await writeLease(umbrellaLiveSessionLease(UMB), 'human-terminal-session');
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      ownSessionId: HEADLESS_ID,
      onReply: (key, text) => replies.push({ key, text }),
      onSkip: (_key, owner) => skips.push({ owner }),
    });
    dp.start();

    bus.emit('inbound', umbrellaEvent(KEY, 'a human is live', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(calls).toHaveLength(0); // ZERO tokens — never called the loop
    expect(replies).toHaveLength(0);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.owner).toBe(`umbrella=${UMB}`);

    await dp.shutdown();
    sm.shutdown();
  });

  it('answers when WE hold a fresh umbrella lease (our headless id)', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['headless reply'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    // WE hold a fresh lease (the headless daemon acquired it).
    await writeLease(umbrellaLiveSessionLease(UMB), HEADLESS_ID);
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      ownSessionId: HEADLESS_ID,
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', umbrellaEvent(KEY, 'headless answers', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(calls.length).toBeGreaterThan(0); // we own → we answer
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]?.text).toBe('headless reply');

    await dp.shutdown();
    sm.shutdown();
  });

  it('does NOT answer when the umbrella lease is ABSENT (ownership guard: only answer when we provably hold it)', async () => {
    // Safety invariant: the dispatcher answers ONLY when the lease is fresh +
    // ours. Acquiring the lease is the HeadlessLeaseManager's job (it writes it
    // before the daemon takes turns); the dispatcher never answers on a bare
    // absent lease — that would risk a double-answer the instant a human's
    // unsynced lease lands. No lease on disk → skip → ZERO tokens.
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const calls: ClientCall[] = [];
    const client = makeClient(['must not be used'], calls);
    const bus = new AgentEventBus();
    const replies: { key: SessionKey; text: string }[] = [];
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'api',
        client,
        model: 'm',
        systemPrompt: 's',
        tools: [],
        dispatcher: NOOP_TOOLS,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      ownSessionId: HEADLESS_ID,
      onReply: (key, text) => replies.push({ key, text }),
    });
    dp.start();

    bus.emit('inbound', umbrellaEvent(KEY, 'nobody holds it', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(calls).toHaveLength(0); // no lease ⇒ not ours ⇒ stand down
    expect(replies).toHaveLength(0);

    await dp.shutdown();
    sm.shutdown();
  });
});

describe('ChatDispatcher — CAT.5 resume threads the same session (subscription)', () => {
  it('passes --resume <headlessId> so the headless turn continues the umbrella transcript', async () => {
    const sm = makeManager();
    await sm.getOrCreate(KEY, PROJECT_UUID);
    const cliCalls: { args: string[] }[] = [];
    const stubCli = {
      run: (req: { cli: string; args: string[]; stdin: string }) => {
        cliCalls.push({ args: req.args });
        return Promise.resolve('cli reply');
      },
    };
    const bus = new AgentEventBus();
    // WE hold the umbrella lease so the daemon answers.
    await writeLease(umbrellaLiveSessionLease(UMB), HEADLESS_ID);
    const dp = new ChatDispatcher({
      bus,
      sessionManager: sm,
      agentLoopOptions: {
        mode: 'subscription',
        cli: 'claude',
        args: ['--print'],
        systemPrompt: 'tested',
        client: stubCli,
      },
      batchOptions: { fastDelayMs: 1, defaultDelayMs: 1 },
      ownSessionId: HEADLESS_ID,
    });
    dp.start();

    bus.emit('inbound', umbrellaEvent(KEY, 'continue the conversation', '1'));
    await new Promise((r) => setTimeout(r, 100));

    expect(cliCalls).toHaveLength(1);
    const args = cliCalls[0]?.args ?? [];
    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(args[resumeIdx + 1]).toBe(HEADLESS_ID);

    await dp.shutdown();
    sm.shutdown();
  });
});

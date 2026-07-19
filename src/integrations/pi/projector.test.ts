import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import opensquidPiProjector, { stepPiScopeContinuation } from './projector.js';
import type { PiLifecycleResourceOwner } from './lifecycle_resources.js';
import { FunctionRegistry } from '../../functions/registry.js';
import { defaultLifecyclePipeline } from '../../runtime/hooks/lifecycle/pipeline.js';
import type { RagBackend } from '../../rag/types.js';
import type { Directive } from '../../runtime/types.js';
import type { FullstackScopeCommand } from '../../packs/runtime/fullstack_scope.js';

interface FakeCtx {
  cwd: string;
  hasUI: boolean;
  abort: ReturnType<typeof vi.fn>;
  ui: { notify: ReturnType<typeof vi.fn> };
  sessionManager: {
    getSessionId: ReturnType<typeof vi.fn>;
    getSessionFile: ReturnType<typeof vi.fn>;
  };
}

type Handler = (event: unknown, ctx: FakeCtx) => unknown;
type CommandHandler = (args: string, ctx: FakeCtx) => unknown;

interface FakePi {
  handlers: Map<string, Handler[]>;
  commands: Map<string, CommandHandler>;
  sentMessages: { message: unknown; options: unknown }[];
  sentUserMessages: { content: unknown; options: unknown }[];
}

function makePi(): FakePi & Parameters<typeof projector>[0] {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, CommandHandler>();
  const pi = {
    handlers,
    commands,
    sentMessages: [] as { message: unknown; options: unknown }[],
    sentUserMessages: [] as { content: unknown; options: unknown }[],
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    sendMessage(message: unknown, options?: unknown) {
      pi.sentMessages.push({ message, options });
      return Promise.resolve();
    },
    sendUserMessage(content: unknown, options?: unknown) {
      pi.sentUserMessages.push({ content, options });
    },
  };
  return pi as unknown as FakePi & Parameters<typeof projector>[0];
}

interface FakeLifecycleResourceOwner extends PiLifecycleResourceOwner {
  getSpy: ReturnType<typeof vi.fn>;
  closeSpy: ReturnType<typeof vi.fn>;
}

function makeLifecycleResources(): FakeLifecycleResourceOwner {
  const registry = new FunctionRegistry();
  const ragBackend: RagBackend = {
    init: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    embed: vi.fn(() => Promise.resolve(null)),
    recall: vi.fn(() => Promise.resolve([])),
    storeLesson: vi.fn(() => Promise.resolve()),
    deleteLesson: vi.fn(() => Promise.resolve({ deleted: false, forced: false })),
  };
  const getSpy = vi.fn(() => Promise.resolve({ registry, ragBackend }));
  const closeSpy = vi.fn(() => Promise.resolve());
  return { get: getSpy, close: closeSpy, getSpy, closeSpy };
}

function projector(
  pi: Parameters<typeof opensquidPiProjector>[0],
  overrides: Partial<Parameters<typeof opensquidPiProjector>[1]> = {},
): FakeLifecycleResourceOwner {
  const lifecycleResources = makeLifecycleResources();
  opensquidPiProjector(pi, { lifecycleResources, ...overrides });
  return lifecycleResources;
}

function makeCtx(cwd: string, overrides: Partial<FakeCtx> = {}): FakeCtx {
  const base = {
    cwd,
    hasUI: false as const,
    abort: vi.fn(),
    ui: { notify: vi.fn() },
    sessionManager: {
      getSessionId: vi.fn(() => 'pi-session-id'),
      getSessionFile: vi.fn(() => 'pi-session-file'),
    },
  };
  return { ...base, ...overrides };
}

async function fire(pi: FakePi, event: string, payload: unknown, ctx: FakeCtx): Promise<unknown[]> {
  const handlers = pi.handlers.get(event) ?? [];
  const results: unknown[] = [];
  for (const handler of handlers) results.push(await handler(payload, ctx));
  return results;
}

function directive(): Directive {
  return { next_action: { profession: 'scope-architect', rationale: 'continue' } };
}

let cwd = '';

beforeEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OPENSQUID_SESSION_ID;
  delete process.env.OPENSQUID_ITEM_ID;
  delete process.env.OPENSQUID_LOOP_LAP;
  delete process.env.OPENSQUID_PI_READINESS_PROBE;
  cwd = await mkdtemp(join(tmpdir(), 'opensquid-pi-projector-'));
});

afterEach(async () => {
  delete process.env.OPENSQUID_SESSION_ID;
  delete process.env.OPENSQUID_ITEM_ID;
  delete process.env.OPENSQUID_LOOP_LAP;
  delete process.env.OPENSQUID_PI_READINESS_PROBE;
  await rm(cwd, { recursive: true, force: true });
});

describe('Pi lifecycle projector', () => {
  it('loads without executing lap lifecycle during the stage-runtime readiness probe', async () => {
    const pi = makePi();
    projector(pi);
    const runSessionStart = vi.spyOn(defaultLifecyclePipeline, 'runSessionStart');
    const runSessionEnd = vi.spyOn(defaultLifecyclePipeline, 'runSessionEnd');
    process.env.OPENSQUID_PI_READINESS_PROBE = '1';
    const ctx = makeCtx(cwd);

    await fire(pi, 'session_start', { reason: 'startup' }, ctx);
    await fire(pi, 'session_shutdown', {}, ctx);

    expect(runSessionStart).not.toHaveBeenCalled();
    expect(runSessionEnd).not.toHaveBeenCalled();
  });

  it('treats reload as runtime replacement: initialize fresh resources without ending or restarting the logical session', async () => {
    const pi = makePi();
    const lifecycleResources = projector(pi);
    const ctx = makeCtx(cwd);
    const runSessionStart = vi.spyOn(defaultLifecyclePipeline, 'runSessionStart');
    const runSessionEnd = vi.spyOn(defaultLifecyclePipeline, 'runSessionEnd');

    await fire(pi, 'session_start', { reason: 'reload' }, ctx);
    await fire(pi, 'session_shutdown', { reason: 'reload' }, ctx);

    expect(lifecycleResources.getSpy).toHaveBeenCalledTimes(1);
    expect(runSessionStart).not.toHaveBeenCalled();
    expect(runSessionEnd).not.toHaveBeenCalled();
    expect(lifecycleResources.closeSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['quit', 'new', 'resume', 'fork'] as const)(
    'finalizes the logical session before closing runtime resources on %s',
    async (reason) => {
      const pi = makePi();
      const lifecycleResources = projector(pi);
      const ctx = makeCtx(cwd);
      const runSessionEnd = vi.spyOn(defaultLifecyclePipeline, 'runSessionEnd').mockResolvedValue({
        exitCode: 0,
        stderr: '',
        contextInjections: [],
        directives: [],
        diagnostics: [],
      });

      await fire(pi, 'session_shutdown', { reason }, ctx);

      expect(runSessionEnd).toHaveBeenCalledTimes(1);
      expect(lifecycleResources.closeSpy).toHaveBeenCalledTimes(1);
      expect(runSessionEnd.mock.invocationCallOrder[0]).toBeLessThan(
        lifecycleResources.closeSpy.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('runs prompt submit once and injects exact-deduped context through only the per-turn system prompt', async () => {
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    const runSessionStart = vi
      .spyOn(defaultLifecyclePipeline, 'runSessionStart')
      .mockResolvedValue({
        exitCode: 0,
        stderr: '',
        contextInjections: ['session-start'],
        directives: [directive()],
        diagnostics: [],
      });
    const runPromptSubmit = vi
      .spyOn(defaultLifecyclePipeline, 'runPromptSubmit')
      .mockResolvedValue({
        exitCode: 0,
        stderr: '',
        contextInjections: ['prompt-submit'],
        directives: [directive()],
        diagnostics: [],
      });

    await fire(
      pi,
      'agent_end',
      {
        type: 'agent_end',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'first ask' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'first' },
              { type: 'thinking', thinking: 'ignored' },
              { type: 'text', text: ' reply' },
            ],
            stopReason: 'stop',
          },
        ],
      },
      ctx,
    );
    await fire(pi, 'session_start', { reason: 'startup' }, ctx);
    const [result] = await fire(
      pi,
      'before_agent_start',
      { prompt: 'hello', systemPrompt: 'BASE ROLE', systemPromptOptions: {} },
      ctx,
    );

    expect(runSessionStart).toHaveBeenCalledTimes(1);
    expect(runPromptSubmit).toHaveBeenCalledTimes(1);
    expect(runPromptSubmit.mock.calls[0]?.[0]).toEqual({
      event: {
        kind: 'prompt_submit',
        prompt: 'hello',
        priorAssistantText: 'first reply',
        recentTurns: 'User: first ask\n\nAssistant: first reply',
      },
    });
    const directiveBlock =
      '⛔ DIRECTIVE — next action required:\n```json\n' +
      JSON.stringify([directive()], null, 2) +
      '\n```';
    expect(result).toEqual({
      systemPrompt: `BASE ROLE\n\nsession-start\n\n${directiveBlock}\n\nprompt-submit`,
    });
    expect(result).not.toHaveProperty('message');
  });

  it('keeps repeated per-turn context bounded and never persists a duplicate custom message', async () => {
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    vi.spyOn(defaultLifecyclePipeline, 'runPromptSubmit').mockResolvedValue({
      exitCode: 0,
      stderr: '',
      contextInjections: ['same-context', 'same-context'],
      directives: [],
      diagnostics: [],
    });

    for (let turn = 0; turn < 25; turn += 1) {
      const [result] = await fire(
        pi,
        'before_agent_start',
        { prompt: `turn-${String(turn)}`, systemPrompt: 'BASE', systemPromptOptions: {} },
        ctx,
      );
      expect(result).toEqual({ systemPrompt: 'BASE\n\nsame-context' });
    }
    expect(pi.sentMessages).toEqual([]);
  });

  it('adapts /scope-done to the shared coordinator with explicit Pi cwd and truthful loop error retry', async () => {
    const pi = makePi();
    const completeScope = vi.fn(() =>
      Promise.resolve({
        kind: 'scope_handoff' as const,
        wgId: 'wg-1',
        artifact: '/workspace/docs/research/scope.md',
        artifactSha256: 'a'.repeat(64),
        evidenceKind: 'approval' as const,
        actionId: `scope-handoff:v1:${'b'.repeat(64)}`,
        transition: 'entered' as const,
        checkpointStage: 'scope_write',
        loop: { status: 'error' as const, error: 'spawn failed' },
      }),
    );
    projector(pi, { completeScope });
    const ctx = makeCtx('/workspace/opensquid');

    await pi.commands.get('scope-done')?.('wg-1 /workspace/docs/research/scope.md', ctx);

    expect(completeScope).toHaveBeenCalledWith({
      wgId: 'wg-1',
      artifact: '/workspace/docs/research/scope.md',
      cwd: '/workspace/opensquid',
    });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('three bounded loop start attempts failed'),
      'error',
    );
  });

  it('projects native /scope through the shared descriptor and queues existing SCOPE context before follow-up', async () => {
    const pi = makePi();
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: 'engaged' as const,
        itemId: 'wg-123456789abc',
        context: 'EXISTING SCOPE CONTEXT',
        continuationPrompt:
          'Begin interactive SCOPE for WorkGraph item wg-123456789abc: exact title',
      }),
    );
    const scopeCommand: FullstackScopeCommand = {
      name: 'scope',
      description: 'shared descriptor',
      execute,
    };
    projector(pi, { scopeCommand });
    const ctx = makeCtx('/workspace/opensquid');
    vi.spyOn(defaultLifecyclePipeline, 'runPromptSubmit').mockResolvedValue({
      exitCode: 0,
      stderr: '',
      contextInjections: [],
      directives: [],
      diagnostics: [],
    });

    await pi.commands.get('scope')?.('ship  exact bytes', ctx);
    expect(execute).toHaveBeenCalledWith({
      raw: '/scope ship  exact bytes',
      sessionId: 'pi-session-id',
      cwd: '/workspace/opensquid',
    });
    expect(pi.sentUserMessages).toEqual([
      {
        content: 'Begin interactive SCOPE for WorkGraph item wg-123456789abc: exact title',
        options: { deliverAs: 'followUp' },
      },
    ]);
    const [unrelated] = await fire(
      pi,
      'before_agent_start',
      { prompt: 'unrelated prompt', systemPrompt: 'BASE', systemPromptOptions: {} },
      ctx,
    );
    expect(unrelated).toEqual({ systemPrompt: 'BASE' });

    const [result] = await fire(
      pi,
      'before_agent_start',
      {
        prompt: 'Begin interactive SCOPE for WorkGraph item wg-123456789abc: exact title',
        systemPrompt: 'BASE',
        systemPromptOptions: {},
      },
      ctx,
    );
    expect(result).toEqual({ systemPrompt: 'BASE\n\nEXISTING SCOPE CONTEXT' });
  });

  it('does not continue Pi after a rejected scope entry and restores correlated context on synchronous dispatch failure', async () => {
    const rejectedPi = makePi();
    projector(rejectedPi, {
      scopeCommand: {
        name: 'scope',
        description: 'shared descriptor',
        execute: () => Promise.resolve({ kind: 'rejected', message: 'bad item' }),
      },
    });
    const rejectedCtx = makeCtx(cwd);
    await rejectedPi.commands.get('scope')?.('--item bad', rejectedCtx);
    expect(rejectedPi.sentUserMessages).toEqual([]);
    expect(rejectedCtx.ui.notify).toHaveBeenCalledWith('bad item', 'error');

    const failedPi = makePi();
    failedPi.sendUserMessage = vi.fn(() => {
      throw new Error('send failed');
    });
    projector(failedPi, {
      scopeCommand: {
        name: 'scope',
        description: 'shared descriptor',
        execute: () =>
          Promise.resolve({
            kind: 'engaged',
            itemId: 'wg-123456789abc',
            context: 'MUST NOT LEAK',
            continuationPrompt: 'continue',
          }),
      },
    });
    const failedCtx = makeCtx(cwd);
    await failedPi.commands.get('scope')?.('ship', failedCtx);
    expect(failedCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Retry /scope --item wg-123456789abc'),
      'error',
    );
    vi.spyOn(defaultLifecyclePipeline, 'runPromptSubmit').mockResolvedValue({
      exitCode: 0,
      stderr: '',
      contextInjections: [],
      directives: [],
      diagnostics: [],
    });
    const [result] = await fire(
      failedPi,
      'before_agent_start',
      { prompt: 'next', systemPrompt: 'BASE', systemPromptOptions: {} },
      failedCtx,
    );
    expect(result).toEqual({ systemPrompt: 'BASE' });
  });

  it('keeps the Pi continuation reducer total', () => {
    for (const state of ['idle', 'queued', 'sent', 'failed'] as const) {
      for (const event of ['queue', 'send_ok', 'send_failed'] as const) {
        expect(() => stepPiScopeContinuation(state, event)).not.toThrow();
      }
    }
  });

  it('uses OPENSQUID_SESSION_ID first and then sessionManager.getSessionId without falling back to session files', async () => {
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    const runSessionStart = vi
      .spyOn(defaultLifecyclePipeline, 'runSessionStart')
      .mockResolvedValue({
        exitCode: 0,
        stderr: '',
        contextInjections: [],
        directives: [],
        diagnostics: [],
      });

    process.env.OPENSQUID_SESSION_ID = 'explicit-session';
    await fire(pi, 'session_start', { reason: 'startup' }, ctx);
    expect(runSessionStart.mock.calls[0]?.[1]).toMatchObject({ sessionId: 'explicit-session' });
    expect(ctx.sessionManager.getSessionId).not.toHaveBeenCalled();
    expect(ctx.sessionManager.getSessionFile).not.toHaveBeenCalled();

    runSessionStart.mockClear();
    delete process.env.OPENSQUID_SESSION_ID;
    await fire(pi, 'session_start', { reason: 'startup' }, ctx);
    expect(runSessionStart.mock.calls[0]?.[1]).toMatchObject({ sessionId: 'pi-session-id' });
    expect(ctx.sessionManager.getSessionId).toHaveBeenCalled();
    expect(ctx.sessionManager.getSessionFile).not.toHaveBeenCalled();
  });

  it('fails closed on prompt exitCode 2 by aborting the turn without throwing extension_error', async () => {
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    vi.spyOn(defaultLifecyclePipeline, 'runPromptSubmit').mockResolvedValue({
      exitCode: 2,
      stderr: 'blocked',
      contextInjections: ['ctx'],
      directives: [directive()],
      diagnostics: [],
    });

    const [result] = await fire(
      pi,
      'before_agent_start',
      { prompt: 'blocked', systemPrompt: 'BASE', systemPromptOptions: {} },
      ctx,
    );

    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      systemPrompt:
        'BASE\n\nblocked\n\nctx\n\n⛔ DIRECTIVE — next action required:\n```json\n' +
        JSON.stringify([directive()], null, 2) +
        '\n```',
    });
  });

  it('keeps correlated execution and same-file reservations on evaluator fail-open', async () => {
    process.env.OPENSQUID_SESSION_ID = 'pi-attempt';
    await writeFile(join(cwd, 'file.txt'), 'alpha\n');
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    vi.spyOn(defaultLifecyclePipeline, 'runPreToolCall').mockRejectedValue(new Error('boom'));
    const runPostToolCall = vi
      .spyOn(defaultLifecyclePipeline, 'runPostToolCall')
      .mockResolvedValue({
        exitCode: 0,
        stderr: '',
        contextInjections: [],
        directives: [],
        diagnostics: [],
      });

    const [first] = await fire(
      pi,
      'tool_call',
      {
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'write',
        input: { path: 'file.txt', content: 'ALPHA' },
      },
      ctx,
    );
    const [second] = await fire(
      pi,
      'tool_call',
      {
        type: 'tool_call',
        toolCallId: 't2',
        toolName: 'write',
        input: { path: 'file.txt', content: 'BETA' },
      },
      ctx,
    );

    expect(first).toBeUndefined();
    expect(second).toMatchObject({ block: true });

    await fire(
      pi,
      'tool_result',
      {
        type: 'tool_result',
        toolCallId: 't2',
        toolName: 'write',
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    expect(runPostToolCall).toHaveBeenCalledTimes(0);

    await fire(
      pi,
      'tool_result',
      {
        type: 'tool_result',
        toolCallId: 't1',
        toolName: 'write',
        input: {},
        content: [],
        isError: false,
      },
      ctx,
    );
    expect(runPostToolCall).toHaveBeenCalledTimes(1);
  });

  it('reserves only write/edit mutations: read+write same-file and different-file writes can proceed in parallel', async () => {
    process.env.OPENSQUID_SESSION_ID = 'pi-attempt';
    await writeFile(join(cwd, 'a.txt'), 'alpha\n');
    await writeFile(join(cwd, 'b.txt'), 'beta\n');
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    vi.spyOn(defaultLifecyclePipeline, 'runPreToolCall').mockResolvedValue({
      block: false,
      contextInjections: [],
      diagnostics: [],
    });
    vi.spyOn(defaultLifecyclePipeline, 'runSessionEnd').mockResolvedValue({
      exitCode: 0,
      stderr: '',
      contextInjections: [],
      directives: [],
      diagnostics: [],
    });

    const [writeA] = await fire(
      pi,
      'tool_call',
      {
        type: 'tool_call',
        toolCallId: 'w1',
        toolName: 'write',
        input: { path: 'a.txt', content: 'A' },
      },
      ctx,
    );
    const [readA] = await fire(
      pi,
      'tool_call',
      { type: 'tool_call', toolCallId: 'r1', toolName: 'read', input: { path: 'a.txt' } },
      ctx,
    );
    const [writeB] = await fire(
      pi,
      'tool_call',
      {
        type: 'tool_call',
        toolCallId: 'w2',
        toolName: 'write',
        input: { path: 'b.txt', content: 'B' },
      },
      ctx,
    );

    expect(writeA).toBeUndefined();
    expect(readA).toBeUndefined();
    expect(writeB).toBeUndefined();

    await fire(pi, 'session_shutdown', { reason: 'quit' }, ctx);

    const [afterShutdown] = await fire(
      pi,
      'tool_call',
      {
        type: 'tool_call',
        toolCallId: 'w3',
        toolName: 'write',
        input: { path: 'a.txt', content: 'C' },
      },
      ctx,
    );
    expect(afterShutdown).toBeUndefined();
  });

  it('observes only actually executed correlated tool results, including non-zero Bash', async () => {
    process.env.OPENSQUID_SESSION_ID = 'pi-attempt';
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    vi.spyOn(defaultLifecyclePipeline, 'runPreToolCall').mockResolvedValue({
      block: false,
      contextInjections: [],
      diagnostics: [],
    });
    const runPostToolCall = vi
      .spyOn(defaultLifecyclePipeline, 'runPostToolCall')
      .mockResolvedValue({
        exitCode: 0,
        stderr: '',
        contextInjections: [],
        directives: [],
        diagnostics: [],
      });

    await fire(
      pi,
      'tool_call',
      { type: 'tool_call', toolCallId: 'bash-1', toolName: 'bash', input: { command: 'exit 1' } },
      ctx,
    );

    await fire(
      pi,
      'tool_result',
      {
        type: 'tool_result',
        toolCallId: 'missing',
        toolName: 'bash',
        input: {},
        content: [],
        isError: true,
      },
      ctx,
    );
    await fire(
      pi,
      'tool_result',
      {
        type: 'tool_result',
        toolCallId: 'bash-1',
        toolName: 'bash',
        input: {},
        content: [],
        isError: true,
      },
      ctx,
    );

    expect(runPostToolCall).toHaveBeenCalledTimes(1);
    expect(runPostToolCall.mock.calls[0]?.[0]).toEqual({
      event: {
        kind: 'post_tool_call',
        tool: 'Bash',
        args: { command: 'exit 1' },
        cwd,
        exit_code: 1,
      },
    });
  });

  it('runs Stop only on success, uses the last assistant text, and queues continuation follow-ups before settlement', async () => {
    const pi = makePi();
    projector(pi);
    const ctx = makeCtx(cwd);
    const runStop = vi.spyOn(defaultLifecyclePipeline, 'runStop').mockResolvedValueOnce({
      exitCode: 0,
      stderr: '',
      contextInjections: [],
      directives: [],
      diagnostics: [],
      continuationReason: 'continue with queued work',
    });

    await fire(
      pi,
      'agent_end',
      {
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'first' }], stopReason: 'stop' },
          { role: 'assistant', content: [{ type: 'text', text: 'last' }], stopReason: 'stop' },
        ],
      },
      ctx,
    );

    expect(runStop.mock.calls[0]?.[0]).toEqual({
      event: { kind: 'stop', assistantText: 'last' },
      isLoopLap: false,
    });
    expect(pi.sentUserMessages).toContainEqual({
      content: 'continue with queued work',
      options: { deliverAs: 'followUp' },
    });

    runStop.mockReset();
    runStop.mockResolvedValueOnce({
      exitCode: 2,
      stderr: 'blocked',
      contextInjections: ['ctx'],
      directives: [directive()],
      diagnostics: [],
    });

    await fire(
      pi,
      'agent_end',
      {
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'again' }], stopReason: 'stop' },
        ],
      },
      ctx,
    );

    expect(pi.sentUserMessages).toContainEqual({
      content:
        'blocked\n\nctx\n\n⛔ DIRECTIVE — next action required:\n```json\n' +
        JSON.stringify([directive()], null, 2) +
        '\n```',
      options: { deliverAs: 'followUp' },
    });

    runStop.mockClear();
    await fire(
      pi,
      'agent_end',
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'retry me' }],
            stopReason: 'length',
          },
        ],
      },
      ctx,
    );
    expect(runStop).not.toHaveBeenCalled();
  });
});

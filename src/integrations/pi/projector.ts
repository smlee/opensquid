import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from './protocol.js';

import { canonicalizePiToolCall } from './canonicalize.js';
import { defaultLifecyclePipeline } from '../../runtime/hooks/lifecycle/pipeline.js';
import { formatDirectiveBlock } from '../../runtime/hooks/lifecycle/projector.js';
import type {
  Actor,
  LifecycleContext,
  LifecycleOutput,
  LifecycleRole,
} from '../../runtime/hooks/lifecycle/types.js';
import { LOOP_LAP_ENV } from '../../runtime/hooks/subagent_guard.js';
import { PI_READINESS_PROBE_ENV, PI_SHELL_COMMAND_PREFIX_ENV, PI_SHELL_PATH_ENV } from './env.js';
import { completeInteractiveScope } from '../../runtime/ralph/scope_done.js';
import {
  fullstackScopeCommand,
  renderScopeFailure,
  type FullstackScopeCommand,
  type FullstackScopeResult,
} from '../../packs/runtime/fullstack_scope.js';
import {
  createPiLifecycleResourceOwner,
  type PiLifecycleResourceOwner,
} from './lifecycle_resources.js';

const SESSION_ENV = 'OPENSQUID_SESSION_ID';
const ITEM_ENV = 'OPENSQUID_ITEM_ID';
const RECENT_TURNS_LIMIT = 6;

interface ProjectorState {
  pendingSessionStart: string[];
  pendingScopeContinuation: { readonly prompt: string; readonly context: string } | undefined;
  blockedToolCalls: Set<string>;
  executedToolCalls: Map<string, Awaited<ReturnType<typeof canonicalizePiToolCall>>>;
  reservedPaths: Map<string, string>;
  toolReservations: Map<string, string>;
  priorAssistantText?: string;
  recentTurns: string[];
  scopeContinuationChain: Promise<void>;
}

interface PiActorProjection {
  actor: Actor;
  role: LifecycleRole;
  sessionId: string;
}

interface TextBlock {
  type?: unknown;
  text?: unknown;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

function resolveLifecycleSessionId(ctx: ExtensionContext): string {
  const explicit = nonEmpty(process.env[SESSION_ENV]);
  if (explicit !== undefined) return explicit;
  const managerId = nonEmpty(ctx.sessionManager.getSessionId());
  if (managerId !== undefined) return managerId;
  throw new Error('Pi lifecycle session id is unavailable');
}

function projectPiActor(ctx: ExtensionContext): PiActorProjection {
  const sessionId = resolveLifecycleSessionId(ctx);
  if (process.env[LOOP_LAP_ENV] === '1') {
    return {
      actor: { kind: 'stage_process', id: sessionId },
      role: 'stage_process',
      sessionId,
    };
  }
  return { actor: { kind: 'coordinator' }, role: 'interactive', sessionId };
}

function lifecycleContext(ctx: ExtensionContext): LifecycleContext {
  const projection = projectPiActor(ctx);
  const itemId = nonEmpty(process.env[ITEM_ENV]);
  return {
    sessionId: projection.sessionId,
    ...(itemId === undefined ? {} : { itemId }),
    cwd: ctx.cwd,
    actor: projection.actor,
    role: projection.role,
    now: new Date().toISOString(),
  };
}

function reportDiagnostic(_ctx: ExtensionContext, message: string): void {
  try {
    console.error(message);
  } catch {
    // Diagnostics must never become extension_error or change lifecycle behavior.
  }
}

function dedupeAdditions(additions: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const addition of additions) {
    if (addition === '' || seen.has(addition)) continue;
    seen.add(addition);
    unique.push(addition);
  }
  return unique;
}

function appendSystemPrompt(base: string, additions: readonly string[]): string {
  return additions.length === 0 ? base : `${base}\n\n${additions.join('\n\n')}`;
}

function queueContext(pi: ExtensionAPI, additions: readonly string[]): void {
  const unique = dedupeAdditions(additions);
  if (unique.length === 0) return;
  void pi.sendMessage(
    {
      customType: 'opensquid-context',
      content: unique.join('\n\n'),
      display: false,
    },
    { deliverAs: 'followUp' },
  );
}

function releaseReservation(state: ProjectorState, toolCallId: string): void {
  const path = state.toolReservations.get(toolCallId);
  if (path !== undefined && state.reservedPaths.get(path) === toolCallId) {
    state.reservedPaths.delete(path);
  }
  state.toolReservations.delete(toolCallId);
}

function clearRunState(state: ProjectorState): void {
  for (const toolCallId of [...state.toolReservations.keys()])
    releaseReservation(state, toolCallId);
  state.blockedToolCalls.clear();
  state.executedToolCalls.clear();
}

function promptAdditions(output: LifecycleOutput): string[] {
  const additions = [...output.contextInjections];
  const directiveBlock = formatDirectiveBlock(output.directives);
  if (directiveBlock !== null) additions.push(directiveBlock);
  return dedupeAdditions(additions);
}

function promptResult(
  event: BeforeAgentStartEvent,
  additions: readonly string[],
  exitCode: 0 | 2,
  stderr: string,
) {
  const promptAdditions = dedupeAdditions([
    ...(exitCode === 2 && stderr.length > 0 ? [stderr] : []),
    ...additions,
  ]);
  // `before_agent_start` additions are refreshed every turn, so one per-turn system-prompt channel is enough.
  // Returning the same text as `message` would also persist it in the session and send it to the model twice.
  return { systemPrompt: appendSystemPrompt(event.systemPrompt, promptAdditions) };
}

function textFromBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => block as TextBlock)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function findLastAssistantMessage(messages: readonly unknown[]): MessageLike | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as MessageLike | undefined;
    if (message?.role === 'assistant') return message;
  }
  return null;
}

function stopSucceeded(event: AgentEndEvent): boolean {
  const last = findLastAssistantMessage(event.messages);
  if (last === null) return false;
  return (
    last.stopReason !== 'error' && last.stopReason !== 'aborted' && last.stopReason !== 'length'
  );
}

function sessionStartSource(event: SessionStartEvent): 'startup' | 'resume' {
  return event.reason === 'resume' ? 'resume' : 'startup';
}

function toolResultExitCode(event: ToolResultEvent): number {
  return event.isError ? 1 : 0;
}

function updatePromptHistory(state: ProjectorState, messages: readonly unknown[]): void {
  const turns: string[] = [];
  for (const rawMessage of messages) {
    const message = rawMessage as MessageLike;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = textFromBlocks(message.content);
    if (text.trim().length === 0) continue;
    turns.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${text}`);
  }
  if (turns.length > 0) {
    state.recentTurns = [...state.recentTurns, ...turns].slice(-RECENT_TURNS_LIMIT);
  }
  const lastAssistant = findLastAssistantMessage(messages);
  const assistantText = lastAssistant === null ? '' : textFromBlocks(lastAssistant.content);
  if (assistantText.trim().length > 0) state.priorAssistantText = assistantText;
}

function reserveMutationPath(
  state: ProjectorState,
  toolCallId: string,
  path: string | undefined,
): { block: true; reason: string } | undefined {
  if (path === undefined) return undefined;
  const holder = state.reservedPaths.get(path);
  if (holder !== undefined && holder !== toolCallId) {
    state.blockedToolCalls.add(toolCallId);
    return {
      block: true,
      reason:
        'Pi sibling mutation blocked: another tool in this assistant batch already reserved this file. Retry after that write finishes.',
    };
  }
  state.reservedPaths.set(path, toolCallId);
  state.toolReservations.set(toolCallId, path);
  return undefined;
}

function correlateExecution(
  state: ProjectorState,
  canonical: Awaited<ReturnType<typeof canonicalizePiToolCall>>,
): void {
  state.executedToolCalls.set(canonical.toolCallId, canonical);
}

function queueStopContinuation(
  pi: ExtensionAPI,
  output: LifecycleOutput & { continuationReason?: string },
): void {
  if (output.continuationReason !== undefined) {
    void pi.sendUserMessage(output.continuationReason, { deliverAs: 'followUp' });
  }
  if (output.exitCode !== 2) return;
  const content: string[] = [];
  if (output.stderr.length > 0) content.push(output.stderr);
  content.push(...output.contextInjections);
  const directiveBlock = formatDirectiveBlock(output.directives);
  if (directiveBlock !== null) content.push(directiveBlock);
  if (content.length === 0) return;
  void pi.sendUserMessage(content.join('\n\n'), { deliverAs: 'followUp' });
}

export type PiScopeContinuation = 'idle' | 'queued' | 'sent' | 'failed';
export type PiScopeContinuationEvent = 'queue' | 'send_ok' | 'send_failed';

export function stepPiScopeContinuation(
  state: PiScopeContinuation,
  event: PiScopeContinuationEvent,
): PiScopeContinuation {
  if (state === 'idle' && event === 'queue') return 'queued';
  if (state === 'queued' && event === 'send_ok') return 'sent';
  if (state === 'queued' && event === 'send_failed') return 'failed';
  return 'failed';
}

async function continuePiScope(
  result: Extract<FullstackScopeResult, { kind: 'engaged' }>,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ProjectorState,
): Promise<void> {
  const run = state.scopeContinuationChain.then(() => {
    const before = state.pendingScopeContinuation;
    let phase = stepPiScopeContinuation('idle', 'queue');
    // ExtensionAPI.sendUserMessage is deliberately fire-and-forget. Correlate context to the exact generated
    // follow-up instead of placing it in the generic next-turn queue, so an asynchronous extension_error cannot
    // leak SCOPE context into an unrelated later prompt. The single slot is bounded and retries overwrite it.
    state.pendingScopeContinuation = {
      prompt: result.continuationPrompt,
      context: result.context,
    };
    try {
      pi.sendUserMessage(result.continuationPrompt, { deliverAs: 'followUp' });
      phase = stepPiScopeContinuation(phase, 'send_ok');
    } catch (error) {
      phase = stepPiScopeContinuation(phase, 'send_failed');
      state.pendingScopeContinuation = before;
      ctx.ui.notify(
        `scope entry engaged ${result.itemId}, but Pi continuation failed: ${String(error)}. ` +
          `Retry /scope --item ${result.itemId}.`,
        'error',
      );
    }
    if (phase !== 'sent' && phase !== 'failed') {
      throw new Error('Pi scope continuation did not terminate');
    }
  });
  state.scopeContinuationChain = run.catch(() => undefined);
  await run;
}

export interface OpensquidPiProjectorDeps {
  lifecycleResources?: PiLifecycleResourceOwner;
  completeScope?: typeof completeInteractiveScope;
  scopeCommand?: FullstackScopeCommand;
}

export default function opensquidPiProjector(
  pi: ExtensionAPI,
  deps: OpensquidPiProjectorDeps = {},
) {
  const state: ProjectorState = {
    pendingSessionStart: [],
    pendingScopeContinuation: undefined,
    blockedToolCalls: new Set(),
    executedToolCalls: new Map(),
    reservedPaths: new Map(),
    toolReservations: new Map(),
    recentTurns: [],
    scopeContinuationChain: Promise.resolve(),
  };

  pi.registerCommand?.('scope-done', {
    description: 'Persist human-approved scope proof: /scope-done <wg-id> <artifact-path>',
    handler: async (args, ctx) => {
      const [wgId, ...artifactParts] = args.trim().split(/\s+/u);
      const artifact = artifactParts.join(' ');
      if (wgId === undefined || wgId === '' || artifact === '') {
        ctx.ui.notify('usage: /scope-done <wg-id> <artifact-path>', 'error');
        return;
      }
      try {
        const result = await (deps.completeScope ?? completeInteractiveScope)({
          wgId,
          artifact,
          cwd: ctx.cwd,
        });
        if (result.loop.status === 'error') {
          ctx.ui.notify(
            `scope handoff persisted (${result.transition}, ${result.checkpointStage}) but three bounded loop ` +
              `start attempts failed: ${result.loop.error ?? 'unknown error'}. Resolve that cause, then rerun ` +
              `/scope-done ${wgId} ${artifact}; the receipt makes it idempotent.`,
            'error',
          );
        } else {
          ctx.ui.notify(
            `scope handoff ${result.transition} at ${result.checkpointStage}; ` +
              `loop ${result.loop.status} pid ${String(result.loop.pid)}`,
            'info',
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `scope-done failed: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  const scopeCommand = deps.scopeCommand ?? fullstackScopeCommand;
  pi.registerCommand?.(scopeCommand.name, {
    description: scopeCommand.description,
    handler: async (args, ctx) => {
      const raw = args.length === 0 ? '/scope' : `/scope ${args}`;
      let result: FullstackScopeResult;
      try {
        result = await scopeCommand.execute({
          raw,
          sessionId: resolveLifecycleSessionId(ctx),
          cwd: ctx.cwd,
        });
      } catch (error) {
        ctx.ui.notify(`scope entry failed: ${String(error)}`, 'error');
        return;
      }
      if (result.kind !== 'engaged') {
        const message =
          result.kind === 'ignored'
            ? 'usage: /scope <request> | /scope --item <wg-id>'
            : renderScopeFailure(result);
        ctx.ui.notify(message, 'error');
        return;
      }
      await continuePiScope(result, pi, ctx, state);
    },
  });

  const lifecycleResources = deps.lifecycleResources ?? createPiLifecycleResourceOwner();
  const lifecycleWithResources = async (ctx: ExtensionContext): Promise<LifecycleContext> => ({
    ...lifecycleContext(ctx),
    ...(await lifecycleResources.get()),
  });

  pi.on('session_start', async (event: SessionStartEvent, ctx: ExtensionContext) => {
    // The stage-runtime readiness process loads this extension to prove composition and tool registration, but it
    // is not a lap and must not execute pack lifecycle procedures before its probe handler can inspect the tools.
    if (process.env[PI_READINESS_PROBE_ENV] === '1') return;
    try {
      const lifecycle = await lifecycleWithResources(ctx);
      // Pi reload replaces only the extension runtime; it does not begin a new logical conversation.
      if (event.reason === 'reload') return;
      const output = await defaultLifecyclePipeline.runSessionStart(
        { event: { kind: 'session_start', source: sessionStartSource(event), cwd: ctx.cwd } },
        lifecycle,
      );
      state.pendingSessionStart.push(...output.contextInjections);
      const directiveBlock = formatDirectiveBlock(output.directives);
      if (directiveBlock !== null) state.pendingSessionStart.push(directiveBlock);
      if (output.stderr.length > 0) reportDiagnostic(ctx, output.stderr);
    } catch (error) {
      reportDiagnostic(ctx, `opensquid Pi session_start fail-open: ${String(error)}`);
    }
  });

  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    const lifecycle = await lifecycleWithResources(ctx);
    const scopeContext =
      state.pendingScopeContinuation?.prompt === event.prompt
        ? state.pendingScopeContinuation.context
        : undefined;
    if (scopeContext !== undefined) state.pendingScopeContinuation = undefined;
    try {
      const promptEvent = {
        kind: 'prompt_submit' as const,
        prompt: event.prompt,
        ...(state.priorAssistantText === undefined
          ? {}
          : { priorAssistantText: state.priorAssistantText }),
        ...(state.recentTurns.length === 0 ? {} : { recentTurns: state.recentTurns.join('\n\n') }),
      };
      const output = await defaultLifecyclePipeline.runPromptSubmit(
        { event: promptEvent },
        lifecycle,
      );
      const additions = dedupeAdditions([
        ...state.pendingSessionStart,
        ...(scopeContext === undefined ? [] : [scopeContext]),
        ...promptAdditions(output),
      ]);
      state.pendingSessionStart = [];
      if (output.stderr.length > 0) reportDiagnostic(ctx, output.stderr);
      if (output.exitCode === 2) ctx.abort();
      return promptResult(event, additions, output.exitCode, output.stderr);
    } catch (error) {
      state.pendingSessionStart = [];
      reportDiagnostic(ctx, `opensquid Pi before_agent_start fail-open: ${String(error)}`);
      return promptResult(event, scopeContext === undefined ? [] : [scopeContext], 0, '');
    }
  });

  pi.on('tool_call', async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const lifecycle = await lifecycleWithResources(ctx);
    let canonical;
    try {
      canonical = await canonicalizePiToolCall(event, ctx.cwd, {
        ...(process.env[PI_SHELL_COMMAND_PREFIX_ENV] === undefined
          ? {}
          : { commandPrefix: process.env[PI_SHELL_COMMAND_PREFIX_ENV] }),
        ...(process.env[PI_SHELL_PATH_ENV] === undefined
          ? {}
          : { shellPath: process.env[PI_SHELL_PATH_ENV] }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportDiagnostic(ctx, `opensquid Pi tool_call blocked: ${message}`);
      state.blockedToolCalls.add(event.toolCallId);
      return { block: true, reason: message };
    }

    try {
      const decision = await defaultLifecyclePipeline.runPreToolCall(
        {
          event: {
            kind: 'tool_call',
            tool: canonical.tool,
            args: canonical.args,
            cwd: ctx.cwd,
          },
        },
        lifecycle,
      );
      if (decision.diagnostics.length > 0) reportDiagnostic(ctx, decision.diagnostics.join('\n'));
      if (decision.block) {
        state.blockedToolCalls.add(event.toolCallId);
        return {
          block: true,
          reason: decision.reason ?? 'OpenSquid policy blocked this tool call',
        };
      }
      const reservation = reserveMutationPath(state, event.toolCallId, canonical.mutationPath);
      if (reservation !== undefined) return reservation;
      correlateExecution(state, canonical);
      queueContext(pi, decision.contextInjections);
      return undefined;
    } catch (error) {
      reportDiagnostic(ctx, `opensquid Pi tool_call fail-open: ${String(error)}`);
      const reservation = reserveMutationPath(state, event.toolCallId, canonical.mutationPath);
      if (reservation !== undefined) return reservation;
      correlateExecution(state, canonical);
      return undefined;
    }
  });

  pi.on('tool_result', async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (state.blockedToolCalls.delete(event.toolCallId)) return;
    const canonical = state.executedToolCalls.get(event.toolCallId);
    if (canonical === undefined) return;
    const lifecycle = await lifecycleWithResources(ctx);
    try {
      const output = await defaultLifecyclePipeline.runPostToolCall(
        {
          event: {
            kind: 'post_tool_call',
            tool: canonical.tool,
            args: canonical.args,
            cwd: ctx.cwd,
            exit_code: toolResultExitCode(event),
          },
        },
        lifecycle,
      );
      if (output.stderr.length > 0) reportDiagnostic(ctx, output.stderr);
      queueContext(pi, output.contextInjections);
    } catch (error) {
      reportDiagnostic(ctx, `opensquid Pi tool_result fail-open: ${String(error)}`);
    } finally {
      releaseReservation(state, event.toolCallId);
      state.executedToolCalls.delete(event.toolCallId);
      state.blockedToolCalls.delete(event.toolCallId);
    }
  });

  pi.on('agent_end', async (event: AgentEndEvent, ctx: ExtensionContext) => {
    const lifecycle = await lifecycleWithResources(ctx);
    try {
      if (stopSucceeded(event)) {
        const lastAssistant = findLastAssistantMessage(event.messages);
        const assistantText = lastAssistant === null ? '' : textFromBlocks(lastAssistant.content);
        const output = await defaultLifecyclePipeline.runStop(
          {
            event: { kind: 'stop', assistantText },
            isLoopLap: lifecycle.role !== 'interactive',
          },
          lifecycle,
        );
        if (output.stderr.length > 0) reportDiagnostic(ctx, output.stderr);
        queueStopContinuation(pi, output);
      }
    } catch (error) {
      reportDiagnostic(ctx, `opensquid Pi agent_end fail-open: ${String(error)}`);
    } finally {
      clearRunState(state);
      updatePromptHistory(state, event.messages);
    }
  });

  pi.on('session_shutdown', async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    if (process.env[PI_READINESS_PROBE_ENV] === '1') return;
    try {
      // A reload ends this extension runtime, not the logical conversation. Real session replacement/quit
      // reasons still finalize durable OpenSquid state before the runtime-owned backend is closed.
      if (event.reason !== 'reload') {
        const lifecycle = await lifecycleWithResources(ctx);
        const output = await defaultLifecyclePipeline.runSessionEnd(
          {
            event: { kind: 'session_end', sessionId: lifecycle.sessionId },
            isLoopLap: lifecycle.role !== 'interactive',
          },
          lifecycle,
        );
        if (output.stderr.length > 0) reportDiagnostic(ctx, output.stderr);
      }
    } catch (error) {
      reportDiagnostic(ctx, `opensquid Pi session_shutdown fail-open: ${String(error)}`);
    } finally {
      try {
        await lifecycleResources.close();
      } catch (error) {
        reportDiagnostic(ctx, `opensquid Pi runtime resource close failed: ${String(error)}`);
      }
      clearRunState(state);
      state.pendingSessionStart = [];
      delete state.priorAssistantText;
      state.recentTurns = [];
    }
  });
}

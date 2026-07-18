/** One bounded Pi RPC conversation used by disposable StageProcesses and readiness probes. */
import type {
  StreamingCliOptions,
  StreamingRecordContext,
  runStreamingCli,
} from '../../runtime/streaming_cli.js';

export interface PiRpcUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface PiRpcAgentResult {
  text: string;
  usage: PiRpcUsage;
  /** True when Pi supplied either session-statistics cost or message-level native cost, including zero. */
  hasNativeCost: boolean;
  isError: boolean;
  complete: boolean;
  diagnostics: readonly string[];
}

export interface PiRpcTimers {
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface PiRpcAgentSessionOptions {
  runStreaming: typeof runStreamingCli;
  transport: Omit<StreamingCliOptions, 'onStart' | 'onRecord'>;
  prompt: string;
  promptId: string;
  statsId: string;
  statsTimeoutMs?: number;
  timers?: PiRpcTimers;
  /** Observe already-decoded Pi events for adapter-owned telemetry. */
  onEvent?: (event: Readonly<Record<string, unknown>>) => void | Promise<void>;
}

interface SessionState {
  promptAccepted: boolean;
  finalSettlement: boolean;
  statsRequested: boolean;
  statsResolved: boolean;
  statsUsage?: PiRpcUsage;
  messageUsage: PiRpcUsage;
  hasMessageCost: boolean;
  text: string;
  isError: boolean;
  diagnostics: string[];
}

export class PiRpcProtocolError extends Error {}

const DEFAULT_TIMERS: PiRpcTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function describeUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'unknown';
  try {
    return JSON.stringify(value) ?? 'unknown';
  } catch {
    return 'unserializable error';
  }
}

function textFromAssistant(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block !== null)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

function foldAssistantMessage(message: Record<string, unknown>, state: SessionState): void {
  if (message.role !== 'assistant') return;
  state.text = textFromAssistant(message);
  if (
    message.stopReason === 'length' ||
    message.stopReason === 'error' ||
    message.stopReason === 'aborted'
  ) {
    state.isError = true;
  }
  const usage = asRecord(message.usage);
  if (usage === null) return;
  if (finite(usage.input)) state.messageUsage.inputTokens += usage.input;
  if (finite(usage.output)) state.messageUsage.outputTokens += usage.output;
  if (finite(usage.cacheRead)) state.messageUsage.cacheReadTokens += usage.cacheRead;
  if (finite(usage.cacheWrite)) state.messageUsage.cacheWriteTokens += usage.cacheWrite;
  const cost = asRecord(usage.cost);
  if (cost !== null && finite(cost.total)) {
    state.messageUsage.costUsd += cost.total;
    state.hasMessageCost = true;
  }
}

function statisticsUsage(event: Readonly<Record<string, unknown>>): PiRpcUsage | null {
  const data = asRecord(event.data);
  const tokens = asRecord(data?.tokens);
  if (
    data === null ||
    tokens === null ||
    !finite(tokens.input) ||
    !finite(tokens.output) ||
    !finite(data.cost)
  ) {
    return null;
  }
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: finite(tokens.cacheRead) ? tokens.cacheRead : 0,
    cacheWriteTokens: finite(tokens.cacheWrite) ? tokens.cacheWrite : 0,
    costUsd: data.cost,
  };
}

function resultFromState(state: SessionState): PiRpcAgentResult {
  const usage = state.statsUsage ?? state.messageUsage;
  const complete = state.promptAccepted && state.finalSettlement && state.statsResolved;
  return {
    text: state.text,
    usage: { ...usage },
    hasNativeCost: state.statsUsage !== undefined || state.hasMessageCost,
    isError: state.isError || !complete,
    complete,
    diagnostics: [...state.diagnostics],
  };
}

/**
 * Run one model-driven Pi RPC prompt through final settlement and statistics.
 * Process supervision and framing remain in runStreamingCli; this function owns only Pi wire semantics.
 */
export async function runPiRpcAgentSession(
  options: PiRpcAgentSessionOptions,
): Promise<PiRpcAgentResult> {
  const timers = options.timers ?? DEFAULT_TIMERS;
  const state: SessionState = {
    promptAccepted: false,
    finalSettlement: false,
    statsRequested: false,
    statsResolved: false,
    messageUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
    hasMessageCost: false,
    text: '',
    isError: false,
    diagnostics: [],
  };
  let statsTimer: NodeJS.Timeout | undefined;

  const clearStatsTimer = (): void => {
    if (statsTimer === undefined) return;
    timers.clearTimeout(statsTimer);
    statsTimer = undefined;
  };
  const fallbackStatistics = (ctx: StreamingRecordContext, diagnostic: string): void => {
    clearStatsTimer();
    state.diagnostics.push(diagnostic);
    state.statsResolved = true;
    ctx.complete();
  };

  try {
    await options.runStreaming({
      ...options.transport,
      // Pi's JSONL stream repeats full conversation objects and can be large even when every record is valid.
      // The protocol state below is the bounded result; retaining the raw wire transcript adds no value and
      // can abort otherwise healthy long-running laps at the generic capture cap.
      retainStdout: false,
      onStart: (ctx) =>
        ctx.send(JSON.stringify({ id: options.promptId, type: 'prompt', message: options.prompt })),
      onRecord: async (line, ctx) => {
        let event: Record<string, unknown>;
        try {
          const parsed = asRecord(JSON.parse(line) as unknown);
          if (parsed === null) throw new Error('record is not an object');
          event = parsed;
        } catch (error) {
          return {
            fail: new PiRpcProtocolError(
              `Pi RPC malformed JSONL: ${error instanceof Error ? error.message : String(error)}`,
            ),
          };
        }

        await options.onEvent?.(event);

        if (event.type === 'response') {
          if (event.id === options.promptId && event.command === 'prompt') {
            if (event.success !== true) {
              return {
                fail: new PiRpcProtocolError(
                  `Pi RPC prompt rejected: ${describeUnknown(event.error)}`,
                ),
              };
            }
            state.promptAccepted = true;
            return 'continue';
          }
          if (event.id === options.statsId && event.command === 'get_session_stats') {
            clearStatsTimer();
            if (event.success !== true) {
              fallbackStatistics(
                ctx,
                `Pi session statistics failed: ${describeUnknown(event.error)}`,
              );
              return 'continue';
            }
            const usage = statisticsUsage(event);
            if (usage === null) {
              fallbackStatistics(ctx, 'Pi session statistics response was malformed');
              return 'continue';
            }
            state.statsUsage = usage;
            state.statsResolved = true;
            return 'complete';
          }
          return 'continue';
        }

        if (event.type === 'message_end') {
          const message = asRecord(event.message);
          if (message !== null) foldAssistantMessage(message, state);
        } else if (event.type === 'extension_error') {
          state.isError = true;
        } else if (event.type === 'agent_settled') {
          if (state.statsRequested) return 'continue';
          state.finalSettlement = true;
          state.statsRequested = true;
          await ctx.send(JSON.stringify({ id: options.statsId, type: 'get_session_stats' }));
          statsTimer = timers.setTimeout(
            () => fallbackStatistics(ctx, 'Pi session statistics timed out'),
            options.statsTimeoutMs ?? 5_000,
          );
        }
        return 'continue';
      },
    });
  } catch (error) {
    if (!(error instanceof PiRpcProtocolError)) throw error;
    state.isError = true;
    state.diagnostics.push(error.message);
  } finally {
    clearStatsTimer();
  }

  return resultFromState(state);
}

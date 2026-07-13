import { SubagentAbortError } from './supervisor.js';

export const DEFAULT_EXECUTOR_MAX_LAPS = 10;
export const DEFAULT_EXECUTOR_BACKOFF_MS = 250;

export interface ExecutorLoopLimits {
  /** Fresh-context laps allowed for one logical executor assignment. */
  readonly maxLaps: number;
  /** Total wall-clock budget across every lap, backoff, and process cleanup. */
  readonly wallClockMs: number;
  readonly backoffMs: number;
}

export interface ExecutorLapContext {
  /** Stable across every fresh-context lap for this logical executor. */
  readonly executorId: string;
  /** One-based lap number. */
  readonly lap: number;
  /** Remaining total wall-clock budget available to this lap. */
  readonly timeoutMs: number;
}

export type ExecutorLapDecision =
  | { readonly kind: 'complete' }
  | { readonly kind: 'retry'; readonly reason: string }
  | { readonly kind: 'stop'; readonly reason: string };

export interface ExecutorLoopResult<T> {
  readonly laps: readonly T[];
  readonly terminal: 'complete' | 'stopped' | 'exhausted';
  readonly reason?: string;
}

export interface ExecutorLoopDeps {
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

function assertLimits(limits: ExecutorLoopLimits): void {
  if (!Number.isSafeInteger(limits.maxLaps) || limits.maxLaps < 1) {
    throw new Error('executor loop maxLaps must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limits.wallClockMs) || limits.wallClockMs < 1) {
    throw new Error('executor loop wallClockMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(limits.backoffMs) || limits.backoffMs < 0) {
    throw new Error('executor loop backoffMs must be a non-negative safe integer');
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SubagentAbortError();
}

const DEFAULT_DEPS: ExecutorLoopDeps = {
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new SubagentAbortError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new SubagentAbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

/**
 * Run one logical executor as bounded fresh-context laps.
 *
 * Core owns only supervision: stable identity, cancellation, total deadline, backoff, and lap bound.
 * The adapter classifies a lap from its normal typed outcome; packs retain all workflow vocabulary and decide
 * whether the model is allowed to settle successfully inside each lap.
 */
export async function runExecutorLoop<T>(input: {
  readonly executorId: string;
  readonly limits: ExecutorLoopLimits;
  readonly signal: AbortSignal;
  readonly runLap: (context: ExecutorLapContext, signal: AbortSignal) => Promise<T>;
  readonly decide: (lap: T) => ExecutorLapDecision;
  readonly deps?: ExecutorLoopDeps;
}): Promise<ExecutorLoopResult<T>> {
  assertLimits(input.limits);
  throwIfAborted(input.signal);
  const deps = input.deps ?? DEFAULT_DEPS;
  const deadline = deps.now() + input.limits.wallClockMs;
  const laps: T[] = [];
  let lastRetryReason = 'executor did not reach a terminal outcome';

  for (let lap = 1; lap <= input.limits.maxLaps; lap += 1) {
    throwIfAborted(input.signal);
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      return {
        laps: Object.freeze([...laps]),
        terminal: 'exhausted',
        reason: `executor wall-clock budget exhausted after ${String(laps.length)} lap(s)`,
      };
    }

    const result = await input.runLap(
      { executorId: input.executorId, lap, timeoutMs: remaining },
      input.signal,
    );
    laps.push(result);
    const decision = input.decide(result);
    if (decision.kind === 'complete') {
      return { laps: Object.freeze([...laps]), terminal: 'complete' };
    }
    if (decision.kind === 'stop') {
      return {
        laps: Object.freeze([...laps]),
        terminal: 'stopped',
        reason: decision.reason,
      };
    }
    lastRetryReason = decision.reason;

    if (lap < input.limits.maxLaps) {
      const beforeBackoff = deadline - deps.now();
      if (beforeBackoff <= 0) continue;
      const delay = Math.min(input.limits.backoffMs, beforeBackoff);
      if (delay > 0) await deps.sleep(delay, input.signal);
    }
  }

  return {
    laps: Object.freeze([...laps]),
    terminal: 'exhausted',
    reason:
      `executor lap limit exhausted after ${String(input.limits.maxLaps)} lap(s): ` +
      lastRetryReason,
  };
}

/** Stable, workflow-neutral instruction prepended to every fresh executor lap. */
export function executorLapPrompt(task: string, lap: number): string {
  return [
    `You are lap ${String(lap)} of a supervised OpenSquid executor loop.`,
    'Reload truth from the repository and durable OpenSquid state; do not rely on a prior lap transcript.',
    'Continue the assigned task until the active packs and configured verification allow completion.',
    'Do not claim completion while any surfaced drift, failing gate, or failing verification remains.',
    'End with exactly one typed line: RALPH-EXIT: {"kind":"SHIPPED"} only when complete; otherwise use a valid WEDGE or HUMAN_REQUIRED outcome.',
    '',
    'Assigned executor task:',
    task,
  ].join('\n');
}

import { Buffer } from 'node:buffer';

import type { SubagentBatchResult, SubagentRunResult } from './types.js';

export class SubagentAbortError extends Error {
  constructor(message = 'subagent execution aborted') {
    super(message);
    this.name = 'SubagentAbortError';
  }
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  const suffix = '\n\n[truncated]';
  if (utf8Bytes(suffix) >= maxBytes) return suffix.slice(0, Math.max(0, maxBytes));
  let body = text;
  while (utf8Bytes(body) + utf8Bytes(suffix) > maxBytes && body.length > 0) {
    body = body.slice(0, -1);
  }
  return `${body}${suffix}`;
}

export function assertUtf8Limit(text: string, maxBytes: number, label: string): void {
  const size = utf8Bytes(text);
  if (size > maxBytes) {
    throw new Error(`${label} exceeded ${String(maxBytes)} bytes (${String(size)})`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SubagentAbortError();
}

export async function runBounded<TItem, TDetails>(
  items: readonly TItem[],
  concurrency: number,
  signal: AbortSignal,
  run: (item: TItem, signal: AbortSignal, index: number) => Promise<SubagentRunResult<TDetails>>,
): Promise<SubagentBatchResult<TDetails>> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const results = Array.from<SubagentRunResult<TDetails> | undefined>({ length: items.length });
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  let firstError: Error | undefined;

  try {
    await Promise.allSettled(
      Array.from({ length: limit }, async () => {
        while (true) {
          throwIfAborted(signal);
          throwIfAborted(controller.signal);
          const index = nextIndex;
          nextIndex += 1;
          if (index >= items.length) return;
          try {
            const result = await run(items[index]!, controller.signal, index);
            throwIfAborted(signal);
            throwIfAborted(controller.signal);
            results[index] = result;
          } catch (error) {
            const alreadyAborted = signal.aborted || controller.signal.aborted;
            controller.abort();
            if (signal.aborted) return;
            if (error instanceof SubagentAbortError && alreadyAborted) return;
            firstError ??= error instanceof Error ? error : new Error(String(error));
            return;
          }
        }
      }),
    );
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  throwIfAborted(signal);
  if (firstError !== undefined) throw firstError;
  return Object.freeze({
    results: Object.freeze(results as SubagentRunResult<TDetails>[]),
  });
}

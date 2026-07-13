import { describe, expect, it, vi } from 'vitest';

import { executorLapPrompt, runExecutorLoop } from './executor_loop.js';
import { SubagentAbortError } from './supervisor.js';

const limits = { maxLaps: 3, wallClockMs: 1_000, backoffMs: 10 } as const;

describe('runExecutorLoop', () => {
  it('keeps one executor identity across fresh laps and stops only on adapter-classified completion', async () => {
    let now = 100;
    const seen: { executorId: string; lap: number; timeoutMs: number }[] = [];
    const result = await runExecutorLoop({
      executorId: 'exec-1',
      limits,
      signal: new AbortController().signal,
      runLap: (context) => {
        seen.push(context);
        now += 100;
        return Promise.resolve(context.lap);
      },
      decide: (lap) =>
        lap === 3 ? { kind: 'complete' } : { kind: 'retry', reason: 'drift remains' },
      deps: {
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      },
    });

    expect(result).toEqual({ laps: [1, 2, 3], terminal: 'complete' });
    expect(seen).toEqual([
      { executorId: 'exec-1', lap: 1, timeoutMs: 1_000 },
      { executorId: 'exec-1', lap: 2, timeoutMs: 890 },
      { executorId: 'exec-1', lap: 3, timeoutMs: 780 },
    ]);
  });

  it('terminates on a non-retry outcome without consuming another lap', async () => {
    const runLap = vi.fn(() => Promise.resolve('wedge'));
    await expect(
      runExecutorLoop({
        executorId: 'exec-2',
        limits,
        signal: new AbortController().signal,
        runLap,
        decide: () => ({ kind: 'stop', reason: 'typed WEDGE' }),
        deps: { now: () => 0, sleep: () => Promise.resolve() },
      }),
    ).resolves.toEqual({ laps: ['wedge'], terminal: 'stopped', reason: 'typed WEDGE' });
    expect(runLap).toHaveBeenCalledTimes(1);
  });

  it('fails boundedly on both the lap limit and total deadline', async () => {
    const byLaps = await runExecutorLoop({
      executorId: 'exec-3',
      limits: { ...limits, maxLaps: 2, backoffMs: 0 },
      signal: new AbortController().signal,
      runLap: ({ lap }) => Promise.resolve(lap),
      decide: () => ({ kind: 'retry', reason: 'missing typed exit' }),
      deps: { now: () => 0, sleep: () => Promise.resolve() },
    });
    expect(byLaps.laps).toEqual([1, 2]);
    expect(byLaps.terminal).toBe('exhausted');
    expect(byLaps.reason).toContain('lap limit exhausted');

    let now = 0;
    const byDeadline = await runExecutorLoop({
      executorId: 'exec-4',
      limits,
      signal: new AbortController().signal,
      runLap: ({ lap }) => {
        now = lap === 1 ? 1_001 : now;
        return Promise.resolve(lap);
      },
      decide: () => ({ kind: 'retry', reason: 'crash' }),
      deps: { now: () => now, sleep: () => Promise.resolve() },
    });
    expect(byDeadline).toEqual({
      laps: [1],
      terminal: 'exhausted',
      reason: 'executor wall-clock budget exhausted after 1 lap(s)',
    });
  });

  it('propagates cancellation rather than converting it to exhaustion', async () => {
    const controller = new AbortController();
    await expect(
      runExecutorLoop({
        executorId: 'exec-5',
        limits,
        signal: controller.signal,
        runLap: () => {
          controller.abort();
          throw new SubagentAbortError();
        },
        decide: () => ({ kind: 'complete' }),
      }),
    ).rejects.toBeInstanceOf(SubagentAbortError);
  });

  it('renders a fresh-lap task prompt without workflow-stage vocabulary', () => {
    const prompt = executorLapPrompt('fix the requested files', 2);
    expect(prompt).toContain('lap 2');
    expect(prompt).toContain('RALPH-EXIT: {"kind":"SHIPPED"}');
    expect(prompt).toContain('fix the requested files');
    expect(prompt).not.toMatch(/SCOPE|PLAN|AUTHOR|CODE|DEPLOY/u);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { resumeExecutorProcess } from './process_resume.js';

const paused = {
  executorId: 'exec-1',
  processInstanceId: 'instance-1',
  actor: 'executor' as const,
  wgId: 'wg-1',
  role: 'fullstack-executor',
  pid: 123,
  processGroupId: 123,
  processStartIdentity: 'start-123',
  status: 'paused' as const,
  startedAtMs: 1,
  updatedAtMs: 2,
  availableActions: [],
};

describe('resumeExecutorProcess', () => {
  it('releases the WorkGraph claim, regains loop control, then records resumed', async () => {
    const order: string[] = [];
    const result = await resumeExecutorProcess(
      {
        executorId: 'exec-1',
        requestedBy: 'web',
        authorizedBy: 'web:user-1',
        cwd: '/repo',
      },
      {
        list: vi.fn(() => Promise.resolve([paused])),
        releaseClaim: vi.fn(() => {
          order.push('claim');
          return Promise.resolve();
        }),
        ensureLoop: vi.fn(() => {
          order.push('loop');
          return Promise.resolve({ status: 'already_running' as const, pid: 44 });
        }),
        mark: vi.fn(() => {
          order.push('event');
          return Promise.resolve();
        }),
      },
    );
    expect(order).toEqual(['claim', 'loop', 'event']);
    expect(result).toMatchObject({
      executorId: 'exec-1',
      processInstanceId: 'instance-1',
      wgId: 'wg-1',
      requestedBy: 'web',
      authorizedBy: 'web:user-1',
      loopStatus: 'already_running',
    });
  });

  it('refuses to resume a process that is not paused', async () => {
    await expect(
      resumeExecutorProcess(
        {
          executorId: 'exec-1',
          requestedBy: 'cli',
          authorizedBy: 'cli:test',
        },
        {
          list: vi.fn(() => Promise.resolve([{ ...paused, status: 'exited' as const }])),
          releaseClaim: vi.fn(),
          ensureLoop: vi.fn(),
          mark: vi.fn(),
        },
      ),
    ).rejects.toThrow(/cannot resume from status exited/);
  });
});

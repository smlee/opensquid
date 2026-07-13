import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  controlledExecutorProcess,
  listExecutorProcesses,
  markExecutorProcess,
  registerExecutorProcess,
  requestExecutorControl,
  type ExecutorControlRequest,
} from './process_control.js';
import type { ProcControl } from '../spawn_lifecycle.js';

let project: string;
let priorRoot: string | undefined;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'opensquid-process-control-'));
  await mkdir(join(project, '.opensquid'));
  priorRoot = process.env.OPENSQUID_PROJECT_ROOT;
  process.env.OPENSQUID_PROJECT_ROOT = project;
});

afterEach(async () => {
  if (priorRoot === undefined) delete process.env.OPENSQUID_PROJECT_ROOT;
  else process.env.OPENSQUID_PROJECT_ROOT = priorRoot;
  await rm(project, { recursive: true, force: true });
});

describe('executor process-control state/action contract', () => {
  it('publishes JSON-safe state and queues only actions allowed by the current status', async () => {
    await registerExecutorProcess({
      executorId: 'exec-1',
      wgId: 'wg-1',
      role: 'scope-architect',
      pid: 123,
      processGroupId: 123,
      processStartIdentity: 'start-123',
      nowMs: 10,
    });
    expect(await listExecutorProcesses(true)).toEqual([
      expect.objectContaining({
        executorId: 'exec-1',
        status: 'running',
        availableActions: ['graceful_stop', 'terminate', 'force_kill'],
      }),
    ]);

    const kill = vi.fn();
    await expect(
      requestExecutorControl(
        {
          executorId: 'exec-1',
          action: 'terminate',
          requestedBy: 'web',
          authorizedBy: 'web:user-1',
        },
        {
          readIdentity: vi.fn(() =>
            Promise.resolve({ processGroupId: 123, startIdentity: 'start-123' }),
          ),
          kill,
          mark: markExecutorProcess,
          ownerWaitMs: 0,
          sleep: () => Promise.resolve(),
        },
      ),
    ).resolves.toMatchObject({
      executorId: 'exec-1',
      action: 'terminate',
      requestedBy: 'web',
      result: 'applied',
    });
    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');

    await markExecutorProcess('exec-1', 'exited', 0);
    await expect(
      requestExecutorControl({
        executorId: 'exec-1',
        action: 'force_kill',
        requestedBy: 'cli',
        authorizedBy: 'cli:test',
      }),
    ).rejects.toThrow('does not allow force_kill');
  });

  it('keeps delayed lifecycle events from an old process incarnation from overwriting a fresh lap', async () => {
    await registerExecutorProcess({
      executorId: 'stable-executor',
      processInstanceId: 'lap-1-process',
      wgId: 'wg-stable',
      role: 'fullstack-executor',
      pid: 301,
      processGroupId: 301,
      processStartIdentity: 'start-301',
      nowMs: 10,
    });
    await registerExecutorProcess({
      executorId: 'stable-executor',
      processInstanceId: 'lap-2-process',
      wgId: 'wg-stable',
      runId: 'run-stable',
      checkpointStage: 'code',
      lap: 2,
      role: 'fullstack-executor',
      pid: 302,
      processGroupId: 302,
      processStartIdentity: 'start-302',
      nowMs: 20,
    });
    await markExecutorProcess(
      'stable-executor',
      'paused',
      0,
      undefined,
      'wg-stable',
      'lap-1-process',
    );

    await expect(listExecutorProcesses()).resolves.toEqual([
      expect.objectContaining({
        executorId: 'stable-executor',
        processInstanceId: 'lap-2-process',
        runId: 'run-stable',
        checkpointStage: 'code',
        lap: 2,
        pid: 302,
        status: 'running',
      }),
    ]);
  });

  it('refuses a direct signal when PID start identity or process group changed', async () => {
    await registerExecutorProcess({
      executorId: 'exec-reused',
      wgId: 'wg-reused',
      role: 'fullstack-executor',
      pid: 222,
      processGroupId: 222,
      processStartIdentity: 'old-start',
    });
    const kill = vi.fn();
    const receipt = await requestExecutorControl(
      {
        executorId: 'exec-reused',
        action: 'force_kill',
        requestedBy: 'cli',
        authorizedBy: 'cli:test',
      },
      {
        readIdentity: vi.fn(() =>
          Promise.resolve({ processGroupId: 222, startIdentity: 'new-start' }),
        ),
        kill,
        mark: markExecutorProcess,
        ownerWaitMs: 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(receipt.result).toBe('failed');
    expect(receipt.failure).toMatch(/identity changed/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('cascades one parent authorization to active executor groups in the same run', async () => {
    await registerExecutorProcess({
      executorId: 'parent-1',
      processInstanceId: 'parent-process',
      wgId: 'wg-run',
      runId: 'run-1',
      role: 'orchestrator',
      pid: 401,
      processGroupId: 401,
      processStartIdentity: 'start-401',
    });
    await registerExecutorProcess({
      executorId: 'child-1',
      processInstanceId: 'child-process',
      wgId: 'wg-run',
      runId: 'run-1',
      role: 'fullstack-executor',
      pid: 402,
      processGroupId: 402,
      processStartIdentity: 'start-402',
    });
    const kill = vi.fn();
    const receipt = await requestExecutorControl(
      {
        executorId: 'parent-1',
        action: 'force_kill',
        requestedBy: 'web',
        authorizedBy: 'web:user-1',
      },
      {
        readIdentity: (pid) =>
          Promise.resolve({ processGroupId: pid, startIdentity: `start-${String(pid)}` }),
        kill,
        mark: markExecutorProcess,
        ownerWaitMs: 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(receipt.result).toBe('applied');
    expect(receipt.related).toHaveLength(1);
    expect(receipt.related?.[0]?.executorId).toBe('child-1');
    expect(kill).toHaveBeenCalledWith(-401, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(-402, 'SIGKILL');
  });

  it('reconciles an already-absent exact process as an applied idempotent action', async () => {
    await registerExecutorProcess({
      executorId: 'already-gone',
      wgId: 'wg-gone',
      role: 'fullstack-executor',
      pid: 450,
      processGroupId: 450,
      processStartIdentity: 'start-450',
    });
    const missing = Object.assign(new Error('no process found'), { code: 1 });
    const receipt = await requestExecutorControl(
      {
        executorId: 'already-gone',
        action: 'terminate',
        requestedBy: 'tui',
        authorizedBy: 'tui:user-1',
      },
      {
        readIdentity: vi.fn(() => Promise.reject(missing)),
        kill: vi.fn(),
        mark: markExecutorProcess,
        ownerWaitMs: 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(receipt.result).toBe('applied');
    await expect(listExecutorProcesses()).resolves.toEqual([
      expect.objectContaining({ executorId: 'already-gone', status: 'paused' }),
    ]);
  });

  it('automatic cancellation is EOF-only while human requests own TERM and KILL', async () => {
    class FakeChild extends EventEmitter {
      pid = 777;
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      stdin = {
        write: () => true,
        end: vi.fn(() => undefined),
        on: () => undefined,
        once: () => undefined,
        removeListener: () => undefined,
      };
      kill(): boolean {
        return true;
      }
    }
    const child = new FakeChild();
    const kills: { pid: number; signal: NodeJS.Signals | number }[] = [];
    const callbacks: (() => void)[] = [];
    const base: ProcControl = {
      spawn: vi.fn(() => child as never),
      kill: (pid, signal) => kills.push({ pid, signal }),
      setTimeout: (callback) => {
        callbacks.push(callback);
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
      clearTimeout: vi.fn(),
      onExit: vi.fn(),
      offExit: vi.fn(),
    };
    const requests: ExecutorControlRequest[] = [
      {
        seq: 1,
        actionId: 'action-1',
        executorId: 'exec-2',
        processInstanceId: 'instance-2',
        wgId: 'wg-2',
        action: 'terminate',
        requestedBy: 'tui',
        authorizedBy: 'tui:user-1',
        requestedAtMs: 1,
        targetPid: 777,
        targetProcessGroupId: 777,
        targetProcessStartIdentity: 'start-777',
      },
      {
        seq: 2,
        actionId: 'action-2',
        executorId: 'exec-2',
        processInstanceId: 'instance-2',
        wgId: 'wg-2',
        action: 'force_kill',
        requestedBy: 'cli',
        authorizedBy: 'cli:test',
        requestedAtMs: 2,
        targetPid: 777,
        targetProcessGroupId: 777,
        targetProcessStartIdentity: 'start-777',
      },
    ];
    const abort = new AbortController();
    const mark = vi.fn(() => Promise.resolve());
    const control = controlledExecutorProcess({
      executorId: 'exec-2',
      wgId: 'wg-2',
      role: 'pack-architect',
      base,
      automaticSignal: abort.signal,
      processInstanceId: 'instance-2',
      store: {
        register: vi.fn(() => Promise.resolve('instance-2')),
        mark,
        pending: vi.fn(() => Promise.resolve(requests.splice(0))),
        claim: vi.fn(() => Promise.resolve(true)),
        complete: vi.fn((seq: number) =>
          Promise.resolve({
            ...requests.find((request) => request.seq === seq)!,
            result: 'applied' as const,
            appliedAtMs: 3,
          }),
        ),
        setTimeout: base.setTimeout,
        clearTimeout: base.clearTimeout,
      },
    });
    control.procControl.spawn('pi', [], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    abort.abort();
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(kills).toEqual([]);

    await Promise.resolve();
    await Promise.resolve();
    callbacks.shift()?.();
    await vi.waitFor(() =>
      expect(kills).toEqual([
        { pid: -777, signal: 'SIGTERM' },
        { pid: -777, signal: 'SIGKILL' },
      ]),
    );
    child.emit('close', 0);
    await vi.waitFor(() =>
      expect(mark).toHaveBeenCalledWith(
        'exec-2',
        'paused',
        0,
        undefined,
        'wg-2',
        'instance-2',
        undefined,
      ),
    );
  });
});

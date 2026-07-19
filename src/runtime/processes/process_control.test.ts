import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  controlledOwnedProcess,
  listOwnedProcesses,
  markOwnedProcess,
  registerOwnedProcess,
  requestProcessControl,
  type ProcessControlRequest,
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

const listAsAlive = {
  readIdentity: (pid: number) =>
    Promise.resolve({ processGroupId: pid, startIdentity: `start-${String(pid)}` }),
};

describe('owned process-control state/action contract', () => {
  it('publishes JSON-safe state and queues only actions allowed by the current status', async () => {
    await registerOwnedProcess({
      processId: 'exec-1',
      wgId: 'wg-1',
      role: 'scope-architect',
      ownership: 'owned',
      pid: 123,
      processGroupId: 123,
      processStartIdentity: 'start-123',
      nowMs: 10,
    });
    expect(await listOwnedProcesses(true, listAsAlive)).toEqual([
      expect.objectContaining({
        processId: 'exec-1',
        status: 'running',
        availableActions: ['graceful_stop', 'terminate', 'force_kill'],
      }),
    ]);

    const kill = vi.fn();
    await expect(
      requestProcessControl(
        {
          processId: 'exec-1',
          action: 'terminate',
          requestedBy: 'web',
          authorizedBy: 'web:user-1',
        },
        {
          readIdentity: vi.fn(() =>
            Promise.resolve({ processGroupId: 123, startIdentity: 'start-123' }),
          ),
          kill,
          mark: markOwnedProcess,
          ownerWaitMs: 0,
          sleep: () => Promise.resolve(),
        },
      ),
    ).resolves.toMatchObject({
      processId: 'exec-1',
      action: 'terminate',
      requestedBy: 'web',
      result: 'applied',
    });
    expect(kill).toHaveBeenCalledWith(-123, 'SIGTERM');

    await markOwnedProcess('exec-1', 'exited', 0);
    await expect(
      requestProcessControl({
        processId: 'exec-1',
        action: 'force_kill',
        requestedBy: 'cli',
        authorizedBy: 'cli:test',
      }),
    ).rejects.toThrow('does not allow force_kill');
  });

  it('requires an attempt-local process id and isolates replacement attempts', async () => {
    await registerOwnedProcess({
      processId: 'stage-attempt-1',
      processInstanceId: 'process-1',
      wgId: 'wg-stable',
      role: 'stage-process',
      ownership: 'owned',
      pid: 301,
      processGroupId: 301,
      processStartIdentity: 'start-301',
      nowMs: 10,
    });
    await expect(
      registerOwnedProcess({
        processId: 'stage-attempt-1',
        processInstanceId: 'process-2',
        wgId: 'wg-stable',
        role: 'stage-process',
        ownership: 'owned',
        pid: 302,
        processGroupId: 302,
        processStartIdentity: 'start-302',
        nowMs: 20,
      }),
    ).rejects.toThrow('attempt-local process id reused');
    await registerOwnedProcess({
      processId: 'stage-attempt-2',
      processInstanceId: 'process-2',
      wgId: 'wg-stable',
      runId: 'run-stable',
      checkpointStage: 'code',
      lap: 1,
      role: 'stage-process',
      ownership: 'owned',
      pid: 302,
      processGroupId: 302,
      processStartIdentity: 'start-302',
      nowMs: 20,
    });
    await markOwnedProcess('stage-attempt-1', 'paused', 0, undefined, 'wg-stable', 'process-1');

    await expect(listOwnedProcesses(true, listAsAlive)).resolves.toEqual([
      expect.objectContaining({
        processId: 'stage-attempt-2',
        processInstanceId: 'process-2',
        runId: 'run-stable',
        checkpointStage: 'code',
        lap: 1,
        pid: 302,
        status: 'running',
      }),
    ]);
  });

  it('reconciles an exact missing OS incarnation out of the active process view', async () => {
    await registerOwnedProcess({
      processId: 'stale-process',
      processInstanceId: 'stale-instance',
      wgId: 'wg-stale',
      role: 'orchestrator',
      ownership: 'control_root',
      pid: 333,
      processGroupId: 333,
      processStartIdentity: 'start-333',
    });
    const missing = Object.assign(new Error('no process found'), { code: 1 });

    await expect(
      listOwnedProcesses(true, { readIdentity: () => Promise.reject(missing) }),
    ).resolves.toEqual([]);
    await expect(
      listOwnedProcesses(false, { readIdentity: () => Promise.reject(missing) }),
    ).resolves.toEqual([
      expect.objectContaining({
        processId: 'stale-process',
        processInstanceId: 'stale-instance',
        status: 'exited',
      }),
    ]);
  });

  it('refuses a direct signal when PID start identity or process group changed', async () => {
    await registerOwnedProcess({
      processId: 'exec-reused',
      wgId: 'wg-reused',
      role: 'stage-process',
      ownership: 'owned',
      pid: 222,
      processGroupId: 222,
      processStartIdentity: 'old-start',
    });
    const kill = vi.fn();
    const receipt = await requestProcessControl(
      {
        processId: 'exec-reused',
        action: 'force_kill',
        requestedBy: 'cli',
        authorizedBy: 'cli:test',
      },
      {
        readIdentity: vi.fn(() =>
          Promise.resolve({ processGroupId: 222, startIdentity: 'new-start' }),
        ),
        kill,
        mark: markOwnedProcess,
        ownerWaitMs: 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(receipt.result).toBe('failed');
    expect(receipt.failure).toMatch(/identity changed/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('propagates one control-root authorization to related owned process groups in the same run', async () => {
    await registerOwnedProcess({
      processId: 'control-root-1',
      processInstanceId: 'control-root-process',
      wgId: 'wg-run',
      runId: 'run-1',
      role: 'control-root',
      ownership: 'control_root',
      pid: 401,
      processGroupId: 401,
      processStartIdentity: 'start-401',
    });
    await registerOwnedProcess({
      processId: 'related-1',
      processInstanceId: 'related-process',
      wgId: 'wg-run',
      runId: 'run-1',
      role: 'stage-process',
      ownership: 'owned',
      pid: 402,
      processGroupId: 402,
      processStartIdentity: 'start-402',
    });
    const kill = vi.fn();
    const receipt = await requestProcessControl(
      {
        processId: 'control-root-1',
        action: 'force_kill',
        requestedBy: 'web',
        authorizedBy: 'web:user-1',
      },
      {
        readIdentity: (pid) =>
          Promise.resolve({ processGroupId: pid, startIdentity: `start-${String(pid)}` }),
        kill,
        mark: markOwnedProcess,
        ownerWaitMs: 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(receipt.result).toBe('applied');
    expect(receipt.related).toHaveLength(1);
    expect(receipt.related?.[0]?.processId).toBe('related-1');
    expect(kill).toHaveBeenCalledWith(-401, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(-402, 'SIGKILL');
  });

  it('reconciles an already-absent exact process as an applied idempotent action', async () => {
    await registerOwnedProcess({
      processId: 'already-gone',
      wgId: 'wg-gone',
      role: 'stage-process',
      ownership: 'owned',
      pid: 450,
      processGroupId: 450,
      processStartIdentity: 'start-450',
    });
    const missing = Object.assign(new Error('no process found'), { code: 1 });
    const receipt = await requestProcessControl(
      {
        processId: 'already-gone',
        action: 'terminate',
        requestedBy: 'tui',
        authorizedBy: 'tui:user-1',
      },
      {
        readIdentity: vi.fn(() => Promise.reject(missing)),
        kill: vi.fn(),
        mark: markOwnedProcess,
        ownerWaitMs: 0,
        sleep: () => Promise.resolve(),
      },
    );
    expect(receipt.result).toBe('applied');
    await expect(listOwnedProcesses()).resolves.toEqual([
      expect.objectContaining({ processId: 'already-gone', status: 'paused' }),
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
    const requests: ProcessControlRequest[] = [
      {
        seq: 1,
        actionId: 'action-1',
        processId: 'exec-2',
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
        processId: 'exec-2',
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
    const control = controlledOwnedProcess({
      processId: 'exec-2',
      wgId: 'wg-2',
      role: 'pack-architect',
      ownership: 'owned',
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

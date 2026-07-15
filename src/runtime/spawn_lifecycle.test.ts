/**
 * SUB.2 (T-handoff-nested-session-spam, wg-627effbb2c38) — the shared
 * one-shot spawn lifecycle: SIGTERM at timeout, REF'D grace timer, then
 * process-group SIGKILL; OPENSQUID_SUPERVISED kill-tree marker (outermost
 * helper spawn detaches as group leader, nested spawns join the ancestor's
 * group); OPENSQUID_SUBAGENT hook-policy marker only when markSubagent.
 *
 * HERMETIC (T-spawn-lifecycle-hermetic-tests, wg-23fd463ab434): every case
 * drives the FSM through an INJECTED `procControl` seam (a recording fake
 * `spawn` returning an EventEmitter-based fake child, plus `vi.useFakeTimers()`
 * for the grace/timeout windows) — NO real subprocess, NO temp files, NO
 * wall-clock `waitMs`. The one genuine OS-behavior a fake cannot prove (a real
 * detached grandchild actually reaped by the group SIGKILL) lives in the
 * opt-in e2e job (test/e2e/spawn-lifecycle.e2e.test.ts), off the always-on
 * suite. This removed the CI ENOENT flake (a fixed 700ms wall-clock wait racing a real
 * spawn-chain + file-write on a loaded runner). Mirrors the StageIo DI
 * convention (release/stage_integration.test.ts).
 */

import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  insideSupervisedTree,
  runOneShotCli,
  realProcControl,
  type ProcControl,
} from './spawn_lifecycle.js';

/** The `SpawnOptions` shape — derived from the seam itself (not imported from the real child-process module) so
 *  the unit file stays free of any real-spawn import the hermetic guard forbids. */
type SpawnOptions = Parameters<ProcControl['spawn']>[2];

/** The minimal child surface `runOneShotCli` touches: `.pid`, `.stdout`/`.stderr` data streams, `.stdin`,
 *  `.on('error'|'close')` / `.emit`, and `.kill(signal)` recording the signal (the nested non-detached sweep). */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  signals: (NodeJS.Signals | number)[] = [];
  kill(sig: NodeJS.Signals | number): boolean {
    this.signals.push(sig);
    return true;
  }
}

interface SpawnRecord {
  cli: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
}

/** A recording `procControl`: fake `spawn` (records {cli,args,options} + the child), a `kill` that RECORDS the
 *  detached group sweep instead of firing a real signal, captured `onExit`/`offExit` registrations, and KEEPING
 *  `realProcControl`'s LAZY timers so `vi.useFakeTimers()` (which patches the globals) drives them. */
function recordingProcControl(): {
  pc: ProcControl;
  spawns: SpawnRecord[];
  groupKills: { pid: number; signal: NodeJS.Signals | number }[];
  exitHandlers: (() => void)[];
} {
  const spawns: SpawnRecord[] = [];
  const groupKills: { pid: number; signal: NodeJS.Signals | number }[] = [];
  const exitHandlers: (() => void)[] = [];
  const pc: ProcControl = {
    spawn: (cli, args, options) => {
      const child = new FakeChild();
      spawns.push({ cli, args, options, child });
      return child as unknown as ReturnType<ProcControl['spawn']>;
    },
    kill: (pid, signal) => {
      groupKills.push({ pid, signal }); // records the detached group sweep — no real signal
    },
    setTimeout: realProcControl.setTimeout, // lazy: vitest fake timers patch the global these call through to
    clearTimeout: realProcControl.clearTimeout,
    onExit: (fn) => {
      exitHandlers.push(fn);
    },
    offExit: (fn) => {
      const i = exitHandlers.indexOf(fn);
      if (i >= 0) exitHandlers.splice(i, 1);
    },
  };
  return { pc, spawns, groupKills, exitHandlers };
}

const timeoutError = (ms: number): Error => new Error(`timeout after ${ms}ms`);

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPENSQUID_SUPERVISED;
});

describe('runOneShotCli — basic contracts', () => {
  it('exit 0 → resolves raw stdout (no trim)', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['ok'],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      procControl: pc,
    });
    spawns[0]!.child.stdout.emit('data', Buffer.from('out \n'));
    spawns[0]!.child.emit('close', 0);
    await expect(p).resolves.toBe('out \n');
  });

  it('non-zero exit → rejects with the prefixed message', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['fail'],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      errorPrefix: 'subscription cli ',
      procControl: pc,
    });
    spawns[0]!.child.stderr.emit('data', Buffer.from('boom'));
    spawns[0]!.child.emit('close', 3);
    await expect(p).rejects.toThrow('subscription cli exit 3: boom');
  });

  it('spawn failure → rejects with the prefixed message', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: 'does-not-exist',
      args: [],
      prompt: '',
      timeoutMs: 1_000,
      markSubagent: false,
      timeoutError,
      procControl: pc,
    });
    spawns[0]!.child.emit('error', new Error('ENOENT'));
    await expect(p).rejects.toThrow(/spawn failed/);
  });

  it('stdin write failure rejects and reclaims the already-spawned child', async () => {
    const { pc, spawns, groupKills, exitHandlers } = recordingProcControl();
    const child = new FakeChild();
    child.stdin.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    pc.spawn = () => {
      spawns.push({ cli: process.execPath, args: [], options: {}, child });
      return child as unknown as ReturnType<ProcControl['spawn']>;
    };
    const p = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: 'x',
      timeoutMs: 1_000,
      markSubagent: false,
      timeoutError,
      procControl: pc,
    });
    child.emit('close', null);
    await expect(p).rejects.toThrow(/stdin write failed: Error: EPIPE/);
    expect(child.signals).toEqual([]);
    expect(groupKills).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
    expect(exitHandlers).toEqual([]);
  });
});

describe('runOneShotCli — markers', () => {
  it('markSubagent: child sees SUBAGENT + SUPERVISED', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['env'],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: true,
      timeoutError,
      procControl: pc,
    });
    const env = spawns[0]!.options.env ?? {};
    expect(env.OPENSQUID_SUBAGENT).toBe('1');
    expect(env.OPENSQUID_SUPERVISED).toBe('1');
    spawns[0]!.child.emit('close', 0); // settle the promise
    await p;
  });

  it('bridge spawn (markSubagent false): SUPERVISED but NOT SUBAGENT — the spec-audit finding-1 scenario', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['env2'],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      procControl: pc,
    });
    const env = spawns[0]!.options.env ?? {};
    expect(env.OPENSQUID_SUBAGENT).toBeUndefined();
    expect(env.OPENSQUID_SUPERVISED).toBe('1');
    spawns[0]!.child.emit('close', 0);
    await p;
  });

  it('insideSupervisedTree reads the exact-"1" marker', () => {
    expect(insideSupervisedTree({ OPENSQUID_SUPERVISED: '1' })).toBe(true);
    expect(insideSupervisedTree({})).toBe(false);
    expect(insideSupervisedTree({ OPENSQUID_SUPERVISED: '0' })).toBe(false);
  });

  it('nested (SUPERVISED already set): child is NOT detached (joins the ancestor group); unmarked → detached leader', async () => {
    // The pgid-leadership check reduces to the `detached` arg the seam records — the OS honoring `detached`
    // (group-leader semantics) is Node's contract, not opensquid's to re-verify with a real process.
    process.env.OPENSQUID_SUPERVISED = '1';
    const nested = recordingProcControl();
    const pNested = runOneShotCli({
      cli: process.execPath,
      args: ['pgid'],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      procControl: nested.pc,
    });
    expect(nested.spawns[0]!.options.detached).toBe(false); // joined OUR group, not its own
    nested.spawns[0]!.child.emit('close', 0);
    await pNested;

    delete process.env.OPENSQUID_SUPERVISED;
    const outer = recordingProcControl();
    const pOuter = runOneShotCli({
      cli: process.execPath,
      args: ['pgid'],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      procControl: outer.pc,
    });
    expect(outer.spawns[0]!.options.detached).toBe(true); // outermost spawn detaches as group leader
    outer.spawns[0]!.child.emit('close', 0);
    await pOuter;
  });
});

describe('runOneShotCli — automatic shutdown owns the subprocess tree', () => {
  it('closes stdin, reports shutdown, sends SIGTERM, then SIGKILLs the exact detached group after grace', async () => {
    vi.useFakeTimers();
    const { pc, spawns, groupKills, exitHandlers } = recordingProcControl();
    const shutdown = vi.fn();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['ignore-eof'],
      prompt: '',
      timeoutMs: 400,
      graceMs: 250,
      markSubagent: true,
      timeoutError,
      onShutdownRequested: shutdown,
      procControl: pc,
    }).catch((e: unknown) => e as Error);

    await vi.advanceTimersByTimeAsync(400);
    expect(spawns[0]!.child.stdin.end).toHaveBeenCalled();
    expect(spawns[0]!.child.signals).toEqual([]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exitHandlers).toHaveLength(1);
    expect(groupKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }]);

    await vi.advanceTimersByTimeAsync(250);
    expect(groupKills).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
    expect(exitHandlers).toEqual([]);
    spawns[0]!.child.emit('close', null);
    expect(await p).toMatchObject({ message: 'timeout after 400ms' });
  });

  it('sweeps the owned group when the root exits during grace', async () => {
    vi.useFakeTimers();
    const { pc, spawns, groupKills, exitHandlers } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['obey-term'],
      prompt: '',
      timeoutMs: 100,
      graceMs: 250,
      markSubagent: false,
      timeoutError,
      procControl: pc,
    }).catch((e: unknown) => e as Error);

    await vi.advanceTimersByTimeAsync(100);
    spawns[0]!.child.emit('close', null);
    expect(await p).toMatchObject({ message: 'timeout after 100ms' });
    await vi.advanceTimersByTimeAsync(250);
    expect(groupKills).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
    expect(exitHandlers).toEqual([]);
  });

  it('uses the synchronous supervisor-exit handler when the process exits before grace', async () => {
    vi.useFakeTimers();
    const { pc, spawns, groupKills, exitHandlers } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['ignore-term'],
      prompt: '',
      timeoutMs: 100,
      graceMs: 5_000,
      markSubagent: false,
      timeoutError,
      procControl: pc,
    }).catch((e: unknown) => e as Error);

    await vi.advanceTimersByTimeAsync(100);
    expect(exitHandlers).toHaveLength(1);
    exitHandlers[0]!();
    expect(groupKills).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
    expect(exitHandlers).toEqual([]);
    spawns[0]!.child.emit('close', null);
    await expect(p).resolves.toMatchObject({ message: 'timeout after 100ms' });
  });
});

describe('runOneShotCli — capture cap (CH.3: fail-loud on a runaway stream, both streams)', () => {
  it('rejects fail-loud when stdout exceeds maxCaptureBytes and starts owned-tree cleanup', async () => {
    const { pc, spawns, groupKills, exitHandlers } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      maxCaptureBytes: 16,
      procControl: pc,
    });
    spawns[0]!.child.stdout.emit('data', Buffer.from('X'.repeat(64))); // 64 > 16 bytes
    spawns[0]!.child.emit('close', null);
    await expect(p).rejects.toThrow(/capture cap exceeded: stdout exceeded 16 bytes/);
    expect(spawns[0]!.child.stdin.end).toHaveBeenCalled();
    expect(spawns[0]!.child.signals).toEqual([]);
    expect(groupKills).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
    expect(exitHandlers).toEqual([]);
  });

  it('rejects fail-loud when stderr exceeds maxCaptureBytes — independently of stdout', async () => {
    const { pc, spawns, groupKills, exitHandlers } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      maxCaptureBytes: 16,
      procControl: pc,
    });
    spawns[0]!.child.stderr.emit('data', Buffer.from('E'.repeat(64)));
    spawns[0]!.child.emit('close', null);
    await expect(p).rejects.toThrow(/capture cap exceeded: stderr exceeded 16 bytes/);
    expect(spawns[0]!.child.stdin.end).toHaveBeenCalled();
    expect(spawns[0]!.child.signals).toEqual([]);
    expect(groupKills).toEqual([
      { pid: -4242, signal: 'SIGTERM' },
      { pid: -4242, signal: 'SIGKILL' },
    ]);
    expect(exitHandlers).toEqual([]);
  });

  it('measures BYTES not UTF-16 code units (a multibyte stream trips at the true byte cap)', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      maxCaptureBytes: 4,
      procControl: pc,
    });
    // '€€' is 2 UTF-16 code units (string .length === 2, under the cap) but 6 UTF-8 bytes (over the cap).
    const multibyte = Buffer.from('€€', 'utf8');
    expect(multibyte.length).toBe(6);
    spawns[0]!.child.stdout.emit('data', multibyte);
    spawns[0]!.child.emit('close', null);
    await expect(p).rejects.toThrow(/capture cap exceeded: stdout/); // bytes (6) > cap (4), not chars (2)
  });

  it('resolves normally when both streams stay under the cap (cap branch never taken)', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      maxCaptureBytes: 1024,
      procControl: pc,
    });
    spawns[0]!.child.stdout.emit('data', Buffer.from('small out'));
    spawns[0]!.child.stderr.emit('data', Buffer.from('small err'));
    spawns[0]!.child.emit('close', 0);
    await expect(p).resolves.toBe('small out'); // byte-unchanged: the whole stdout is returned
  });

  it('boundary: exactly cap passes, cap+1 fails (> cap, strict)', async () => {
    const atCap = recordingProcControl();
    const pAt = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      maxCaptureBytes: 8,
      procControl: atCap.pc,
    });
    atCap.spawns[0]!.child.stdout.emit('data', Buffer.from('12345678')); // exactly 8 → passes
    atCap.spawns[0]!.child.emit('close', 0);
    await expect(pAt).resolves.toBe('12345678');

    const overCap = recordingProcControl();
    const pOver = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      maxCaptureBytes: 8,
      procControl: overCap.pc,
    });
    overCap.spawns[0]!.child.stdout.emit('data', Buffer.from('123456789')); // 9 → fails
    overCap.spawns[0]!.child.emit('close', null);
    await expect(pOver).rejects.toThrow(/capture cap exceeded: stdout/);
  });

  it('default (maxCaptureBytes omitted) does not trip on small fixtures', async () => {
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      procControl: pc, // no maxCaptureBytes → the 10 MiB default, never hit by a tiny fixture
    });
    spawns[0]!.child.stdout.emit('data', Buffer.from('ok'));
    spawns[0]!.child.emit('close', 0);
    await expect(p).resolves.toBe('ok');
  });

  it('onStreams fires at most once when an over-cap process later closes', async () => {
    const onStreams = vi.fn();
    const { pc, spawns } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: [],
      prompt: '',
      timeoutMs: 10_000,
      markSubagent: false,
      timeoutError,
      maxCaptureBytes: 16,
      onStreams,
      procControl: pc,
    }).catch(() => undefined);
    spawns[0]!.child.stdout.emit('data', Buffer.from('X'.repeat(64))); // over-cap → shutdown pending
    expect(onStreams).not.toHaveBeenCalled();
    spawns[0]!.child.emit('close', 0); // close settles and reports exactly once
    await p;
    expect(onStreams).toHaveBeenCalledTimes(1);
  });
});

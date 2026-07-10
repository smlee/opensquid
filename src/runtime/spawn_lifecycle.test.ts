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

describe('runOneShotCli — SIGTERM → grace → group SIGKILL', () => {
  it('SIGTERM at timeout, then group SIGKILL after grace (the observed orphan class)', async () => {
    vi.useFakeTimers();
    const { pc, spawns, groupKills } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['ignore-term'],
      prompt: '',
      timeoutMs: 400,
      markSubagent: true,
      timeoutError,
      graceMs: 300,
      procControl: pc,
    }).catch((e: unknown) => e as Error);

    await vi.advanceTimersByTimeAsync(400); // fire the timeout → SIGTERM + arm grace + register the exit handler
    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('timeout after 400ms'); // rejects AT the timeout, not after grace
    expect(spawns[0]!.child.signals).toContain('SIGTERM'); // the child got SIGTERM at the timeout
    expect(groupKills).toHaveLength(0); // not yet — grace has not elapsed

    await vi.advanceTimersByTimeAsync(300); // grace expiry → the group SIGKILL sweep
    expect(groupKills).toEqual([{ pid: -4242, signal: 'SIGKILL' }]); // process.kill(-pid,'SIGKILL') ISSUED (detached)
  });

  it('group sweep issues the detached process.kill(-pid) after grace (real-grandchild reaping → e2e)', async () => {
    // The unit assertion proves the control flow ISSUES the group sweep. The real-grandchild-reaping VALUE
    // (the OS honoring process.kill(-pid,'SIGKILL')) moves to test/e2e/spawn-lifecycle.e2e.test.ts — a fake
    // proves the signal was issued, not OS-honored.
    vi.useFakeTimers();
    const { pc, spawns, groupKills } = recordingProcControl();
    runOneShotCli({
      cli: process.execPath,
      args: ['child-spawner'],
      prompt: '',
      timeoutMs: 400,
      markSubagent: true,
      timeoutError,
      graceMs: 300,
      procControl: pc,
    }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(400);
    expect(spawns[0]!.child.signals).toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(300);
    expect(groupKills).toEqual([{ pid: -4242, signal: 'SIGKILL' }]); // the detached group sweep was issued
  });

  it('FXK.1: a supervisor exiting BEFORE grace kills the child via the exit handler (the 0.5.398 hole)', async () => {
    // The hook-bin shape: the supervisor calls process.exit() milliseconds after the rejection, which destroys
    // ANY timer, ref'd or not. The sync 'exit' handler — captured here as exitHandlers[0] — must issue the kill
    // the (60s) grace timer never gets to fire.
    vi.useFakeTimers();
    const { pc, groupKills, exitHandlers } = recordingProcControl();
    runOneShotCli({
      cli: process.execPath,
      args: ['fxk-child'],
      prompt: '',
      timeoutMs: 300,
      markSubagent: true,
      timeoutError,
      graceMs: 60_000, // 60s away — if the child dies now, it was the EXIT HANDLER, not the timer
      procControl: pc,
    }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(300); // term_sent; the sync 'exit' escalation is registered
    expect(exitHandlers).toHaveLength(1);
    exitHandlers[0]!(); // simulate process.exit() BEFORE grace — the hook-bin shape
    expect(groupKills).toEqual([{ pid: -4242, signal: 'SIGKILL' }]); // the EXIT HANDLER issued the kill the timer didn't
  });

  it('FXK.1: exit-listener registrations return to baseline across sequential calls (bridge-daemon hygiene)', async () => {
    vi.useFakeTimers();
    const { pc, spawns, exitHandlers } = recordingProcControl();
    for (let i = 0; i < 5; i++) {
      const p = runOneShotCli({
        cli: process.execPath,
        args: ['obey2'],
        prompt: '',
        timeoutMs: 200,
        markSubagent: false,
        timeoutError,
        graceMs: 500,
        procControl: pc,
      }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(200); // timeout → term_sent, onExit registered
      expect(exitHandlers).toHaveLength(1);
      spawns[i]!.child.emit('close', 0); // child obeys SIGTERM within grace → closed_late → offExit
      await p;
      expect(exitHandlers).toHaveLength(0); // every onExit registration is matched by an offExit removal
    }
    expect(exitHandlers).toHaveLength(0); // count returns to baseline
  });

  it('SIGTERM-obeying child clears the grace timer (closed_late path — no leaked timer, no group kill)', async () => {
    vi.useFakeTimers();
    const { pc, spawns, groupKills, exitHandlers } = recordingProcControl();
    const p = runOneShotCli({
      cli: process.execPath,
      args: ['obey-term'],
      prompt: '',
      timeoutMs: 300,
      markSubagent: false,
      timeoutError,
      graceMs: 60_000, // a LEAKED ref'd timer at this size would linger — the pass proves clearance
      procControl: pc,
    }).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(300); // timeout → term_sent, grace armed
    spawns[0]!.child.emit('close', 0); // child obeys SIGTERM within grace → closed_late clears grace + offExit
    await p;
    expect(exitHandlers).toHaveLength(0); // offExit was called

    await vi.advanceTimersByTimeAsync(60_000); // advance PAST grace — the grace timer was cleared
    expect(groupKills).toHaveLength(0); // no group kill fired (grace timer cleared in closed_late)
  });
});

describe('runOneShotCli — capture cap (CH.3: fail-loud on a runaway stream, both streams)', () => {
  it('rejects fail-loud when stdout exceeds maxCaptureBytes and group-kills the child', async () => {
    const { pc, spawns, groupKills } = recordingProcControl();
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
    await expect(p).rejects.toThrow(/capture cap exceeded: stdout exceeded 16 bytes/);
    expect(groupKills).toEqual([{ pid: -4242, signal: 'SIGKILL' }]); // the runaway child was killed (detached)
  });

  it('rejects fail-loud when stderr exceeds maxCaptureBytes — independently of stdout', async () => {
    const { pc, spawns, groupKills } = recordingProcControl();
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
    await expect(p).rejects.toThrow(/capture cap exceeded: stderr exceeded 16 bytes/);
    expect(groupKills).toEqual([{ pid: -4242, signal: 'SIGKILL' }]);
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

  it('onStreams fires at most once on an over-cap (via the close after groupKill, not in failCapExceeded)', async () => {
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
    spawns[0]!.child.stdout.emit('data', Buffer.from('X'.repeat(64))); // over-cap → reject (onStreams NOT called here)
    await p;
    expect(onStreams).not.toHaveBeenCalled(); // failCapExceeded does not call onStreams
    spawns[0]!.child.emit('close', 0); // the child's close after groupKill calls onStreams exactly once
    expect(onStreams).toHaveBeenCalledTimes(1);
  });
});

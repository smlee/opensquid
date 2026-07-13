import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { realProcControl, type ProcControl } from './spawn_lifecycle.js';
import { runStreamingCli } from './streaming_cli.js';

class FakeStdin extends EventEmitter {
  readonly writes: string[] = [];
  readonly end = vi.fn();
  accept = true;

  write(text: string): boolean {
    this.writes.push(text);
    return this.accept;
  }
}

class FakeChild extends EventEmitter {
  pid = 777;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new FakeStdin();
  readonly signals: (NodeJS.Signals | number)[] = [];

  kill(signal: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

interface SpawnCall {
  cli: string;
  args: string[];
  options: Record<string, unknown>;
}

function fixture(): {
  pc: ProcControl;
  child: FakeChild;
  spawnCalls: SpawnCall[];
  kills: { pid: number; signal: NodeJS.Signals | number }[];
} {
  const child = new FakeChild();
  const spawnCalls: SpawnCall[] = [];
  const kills: { pid: number; signal: NodeJS.Signals | number }[] = [];
  return {
    child,
    spawnCalls,
    kills,
    pc: {
      spawn: (cli, args, options) => {
        spawnCalls.push({ cli, args, options: options as Record<string, unknown> });
        return child as unknown as ReturnType<ProcControl['spawn']>;
      },
      kill: (pid, signal) => {
        kills.push({ pid, signal });
      },
      setTimeout: realProcControl.setTimeout,
      clearTimeout: realProcControl.clearTimeout,
      onExit: vi.fn(),
      offExit: vi.fn(),
    },
  };
}

function start(
  f: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof runStreamingCli>[0]> = {},
) {
  const records: string[] = [];
  const promise = runStreamingCli({
    cli: 'fixture',
    args: [],
    cwd: '/tmp',
    timeoutMs: 10_000,
    procControl: f.pc,
    onRecord: (record) => {
      records.push(record);
      return 'continue';
    },
    ...overrides,
  });
  return { promise, records };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OPENSQUID_SUPERVISED;
});

describe('runStreamingCli framing and bounds', () => {
  it('uses incremental UTF-8 decoding, strict LF framing, CR stripping, and multiple records', async () => {
    const f = fixture();
    const { promise, records } = start(f);
    const euro = Buffer.from('€');
    f.child.stdout.emit('data', Buffer.concat([Buffer.from('a'), euro.subarray(0, 1)]));
    f.child.stdout.emit(
      'data',
      Buffer.concat([euro.subarray(1), Buffer.from('\r\nb\nunterminated')]),
    );
    await flush();
    expect(records).toEqual(['a€', 'b']);
    f.child.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ stdout: 'a€\r\nb\nunterminated' });
  });

  it('permits an exact-size record and rejects one byte over', async () => {
    const exact = fixture();
    const a = start(exact, { maxRecordBytes: 4 });
    exact.child.stdout.emit('data', Buffer.from('1234\n'));
    await flush();
    exact.child.emit('close', 0);
    await expect(a.promise).resolves.toMatchObject({ code: 0 });
    expect(a.records).toEqual(['1234']);

    const over = fixture();
    const b = start(over, { maxRecordBytes: 4 });
    over.child.stdout.emit('data', Buffer.from('12345'));
    await expect(b.promise).rejects.toThrow(/record cap exceeded/);
    expect(over.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(over.kills).toEqual([]);
  });

  it('enforces the independent per-stream capture cap', async () => {
    const f = fixture();
    const { promise } = start(f, { maxCaptureBytes: 3 });
    f.child.stderr.emit('data', Buffer.from('four'));
    await expect(promise).rejects.toThrow(/capture cap exceeded: stderr/);
  });

  it('can discard verbose stdout while preserving framing and per-record bounds', async () => {
    const f = fixture();
    const { promise, records } = start(f, {
      maxCaptureBytes: 3,
      maxRecordBytes: 8,
      retainStdout: false,
    });
    f.child.stdout.emit('data', Buffer.from('one\ntwo\n'));
    await flush();
    expect(records).toEqual(['one', 'two']);
    f.child.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ stdout: '', code: 0 });
  });
});

describe('runStreamingCli duplex lifecycle', () => {
  it('serializes writes and waits for drain after backpressure', async () => {
    const f = fixture();
    f.child.stdin.accept = false;
    const { promise } = start(f, {
      onStart: async (ctx) => {
        await ctx.send('one');
        await ctx.send('two');
      },
    });
    await flush();
    expect(f.child.stdin.writes).toEqual(['one\n']);
    f.child.stdin.emit('drain');
    await flush();
    expect(f.child.stdin.writes).toEqual(['one\n', 'two\n']);
    f.child.stdin.emit('drain');
    await flush();
    f.child.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ code: 0 });
  });

  it('complete closes input but drains records until process close', async () => {
    const f = fixture();
    const seen: string[] = [];
    const promise = runStreamingCli({
      cli: 'fixture',
      args: [],
      cwd: '/tmp',
      timeoutMs: 10_000,
      procControl: f.pc,
      onRecord: (record) => {
        seen.push(record);
        return record === 'done' ? 'complete' : 'continue';
      },
    });
    f.child.stdout.emit('data', Buffer.from('done\nlate\n'));
    await flush();
    expect(f.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['done', 'late']);
    f.child.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ completed: true });
  });

  it('fatal callback settles once after clean close', async () => {
    const f = fixture();
    const streams = vi.fn();
    const promise = runStreamingCli({
      cli: 'fixture',
      args: [],
      cwd: '/tmp',
      timeoutMs: 10_000,
      procControl: f.pc,
      onStreams: streams,
      onRecord: () => ({ fail: new Error('fatal record') }),
    });
    f.child.stdout.emit('data', Buffer.from('bad\n'));
    await flush();
    expect(f.child.stdin.end).toHaveBeenCalledTimes(1);
    f.child.emit('close', 0);
    f.child.emit('close', 0);
    await expect(promise).rejects.toThrow('fatal record');
    expect(streams).toHaveBeenCalledTimes(1);
  });

  it('graceful-only timeout closes stdin and never sends an OS signal', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const shutdown = vi.fn();
    const { promise } = start(f, {
      processGroup: 'own',
      timeoutMs: 50,
      onShutdownRequested: shutdown,
    });
    const rejection = promise.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await rejection).toMatchObject({ __timeout: true });
    expect(f.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.kills).toEqual([]);
    f.child.emit('close', 0);
  });

  it('never escalates processGroup=own after a graceful shutdown request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    process.env.OPENSQUID_SUPERVISED = '1';
    const { promise } = start(f, { processGroup: 'own', timeoutMs: 50 });
    const rejection = promise.catch((error: unknown) => error);
    expect(f.spawnCalls[0]?.options.detached).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.child.stdin.end).toHaveBeenCalledTimes(1);
    expect(await rejection).toMatchObject({ __timeout: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.kills).toEqual([]);
    f.child.emit('close', 0);
  });

  it('processGroup=auto preserves the existing supervised-tree behavior', async () => {
    process.env.OPENSQUID_SUPERVISED = '1';
    const nested = fixture();
    const nestedStart = start(nested);
    expect(nested.spawnCalls[0]?.options.detached).toBe(false);
    nested.child.emit('close', 0);
    await expect(nestedStart.promise).resolves.toMatchObject({ code: 0 });

    delete process.env.OPENSQUID_SUPERVISED;
    const outer = fixture();
    const outerStart = start(outer);
    expect(outer.spawnCalls[0]?.options.detached).toBe(true);
    outer.child.emit('close', 0);
    await expect(outerStart.promise).resolves.toMatchObject({ code: 0 });
  });
});

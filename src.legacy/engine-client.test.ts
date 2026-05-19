/**
 * engine-client subprocess lifecycle tests.
 *
 * #170 (2026-05-17): the first test for engine-client.ts. Spawned by the
 * pkill-validation incident that surfaced a permanent-stuck-state bug
 * when the engine subprocess exits externally:
 *
 *   1. ensureStarted() spawns subprocess + caches a resolved
 *      `startupAck` promise after the initial ping succeeds.
 *   2. Subprocess dies (pkill / OOM / crash).
 *   3. proc.on("exit") nulls `proc` and `reader` but pre-#170 left
 *      `startupAck` truthy.
 *   4. Next call: ensureStarted() returns the cached resolved
 *      startupAck without respawning. call() then sees `proc === null`
 *      and rejects with "engine subprocess not running" — for the rest
 *      of the MCP server's lifetime.
 *
 * This test mocks `node:child_process` so we can simulate the exit
 * event deterministically without spawning a real binary.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// vi.mock must be set up before the import; dynamic import keeps that ordering.
const { EngineClient } = await import("./engine-client.js");

interface MockProc extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function makeMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

/** Read the next line written to a stream (e.g. mock stdin). */
function nextLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        stream.off("data", onData);
        resolve(buf.slice(0, nl));
      }
    };
    stream.on("data", onData);
  });
}

beforeEach(() => {
  mockSpawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenSquidEngine subprocess lifecycle (#170)", () => {
  it("respawns the subprocess after an external exit", async () => {
    const proc1 = makeMockProc();
    const proc2 = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2);

    // Construct engine via fresh import each test so it has no resolveEngineBin
    // memo from a previous test (resolveEngineBin reads the env var on each call).
    process.env.OPENSQUID_ENGINE_BIN = "/fake/path/loop-engine";
    const engine = new EngineClient();

    // --- First call: triggers ensureStarted() → spawns proc1, sends ping ---
    const callP1 = engine.call<{ ok: true }>("task.example", {});

    // Wait for proc1's stdin to receive the startup ping, then ack it.
    const startupPingLine = await nextLine(proc1.stdin);
    const startupReq = JSON.parse(startupPingLine);
    expect(startupReq.method).toBe("ping");
    proc1.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: startupReq.id, result: { ok: true } }) + "\n",
    );

    // Now proc1's stdin will receive the user's actual call. Respond.
    const userReqLine = await nextLine(proc1.stdin);
    const userReq = JSON.parse(userReqLine);
    expect(userReq.method).toBe("task.example");
    proc1.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: userReq.id, result: { ok: true } }) + "\n",
    );

    await expect(callP1).resolves.toEqual({ ok: true });

    // --- Simulate external subprocess exit ---
    proc1.emit("exit", 1);
    // Give the exit handler microtasks a tick to run.
    await new Promise((r) => setImmediate(r));

    // --- Second call: must respawn proc2 (pre-#170 this would have thrown
    // "engine subprocess not running" because startupAck was still cached) ---
    const callP2 = engine.call<{ ok: true }>("task.example", {});

    const startupPing2 = await nextLine(proc2.stdin);
    const startupReq2 = JSON.parse(startupPing2);
    expect(startupReq2.method).toBe("ping");
    proc2.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: startupReq2.id, result: { ok: true } }) + "\n",
    );

    const userReq2Line = await nextLine(proc2.stdin);
    const userReq2 = JSON.parse(userReq2Line);
    expect(userReq2.method).toBe("task.example");
    proc2.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: userReq2.id, result: { ok: true } }) + "\n",
    );

    await expect(callP2).resolves.toEqual({ ok: true });
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    delete process.env.OPENSQUID_ENGINE_BIN;
  });

  it("rejects in-flight pending calls when the subprocess exits", async () => {
    const proc1 = makeMockProc();
    mockSpawn.mockReturnValueOnce(proc1);

    process.env.OPENSQUID_ENGINE_BIN = "/fake/path/loop-engine";
    const engine = new EngineClient();

    // Start a call, ack the startup ping, then DON'T respond to the user
    // call — instead simulate exit.
    const callP = engine.call("task.example", {});

    const startupPing = await nextLine(proc1.stdin);
    const startupReq = JSON.parse(startupPing);
    proc1.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: startupReq.id, result: { ok: true } }) + "\n",
    );
    // Drain the user-call line so the test doesn't hang on backpressure.
    await nextLine(proc1.stdin);

    // Simulate crash.
    proc1.emit("exit", null);

    await expect(callP).rejects.toThrow(/engine subprocess exited/);

    delete process.env.OPENSQUID_ENGINE_BIN;
  });
});

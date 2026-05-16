/**
 * chat-daemon lifecycle tests (v0.7.1 Phase A).
 *
 * Exercise the start/stop/status surface against REAL detached child
 * processes — the lifecycle logic IS the contract (fork-detach +
 * pidfile + signal handling), so synthetic stubs would prove nothing.
 *
 * Each test uses a tmpdir as the data root so multiple test runs don't
 * collide on the shared ~/.opensquid/chat-daemon.pid path, and so a
 * crashed test doesn't poison a real chat-daemon install.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { daemonPaths, startDaemon, status, stopDaemon } from "./lifecycle.js";

// Resolve to a real on-disk dist/index.js so the spawned worker can
// actually run. Tests assume `npm run build` has been done; vitest's
// suite runner triggers tsc when the build step is wired upstream.
const REPO_ROOT = path.resolve(__dirname, "../../..");
const ENTRYPOINT = path.join(REPO_ROOT, "dist", "index.js");

let tmpDataRoot: string;

beforeEach(async () => {
  tmpDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensquid-daemon-test-"));
});

afterEach(async (ctx) => {
  // On failure, dump the log + tmpdir contents before cleanup so we can
  // see what the daemon was up to. Vitest exposes the task state on ctx.
  if (ctx.task.result?.state === "fail") {
    try {
      const entries = await fs.readdir(tmpDataRoot);
      // eslint-disable-next-line no-console
      console.log(`[test debug] ${tmpDataRoot} entries: ${JSON.stringify(entries)}`);
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[test debug] tmpDataRoot ${tmpDataRoot} missing`);
    }
    try {
      const log = await fs.readFile(path.join(tmpDataRoot, "chat-daemon.log"), "utf8");
      // eslint-disable-next-line no-console
      console.log(`[test debug] ${tmpDataRoot}/chat-daemon.log:\n${log}`);
    } catch {
      // eslint-disable-next-line no-console
      console.log(`[test debug] no chat-daemon.log in ${tmpDataRoot}`);
    }
  }
  // Best-effort: stop any daemon that's still running from a failed
  // test, then rm the tmp root.
  try {
    await stopDaemon({ dataRoot: tmpDataRoot });
  } catch {
    /* ignore */
  }
  await fs.rm(tmpDataRoot, { recursive: true, force: true });
});

function dataRootEnv(): {
  dataRoot: string;
  entrypoint: string;
} {
  return { dataRoot: tmpDataRoot, entrypoint: ENTRYPOINT };
}

describe("daemonPaths", () => {
  it("derives pid/log/sock paths from the data root", () => {
    const p = daemonPaths(tmpDataRoot);
    expect(p.pidFile).toBe(path.join(tmpDataRoot, "chat-daemon.pid"));
    expect(p.logFile).toBe(path.join(tmpDataRoot, "chat-daemon.log"));
    expect(p.sockFile).toBe(path.join(tmpDataRoot, "chat-daemon.sock"));
  });
});

describe("status (before any start)", () => {
  it("reports not-running when pidfile is absent", async () => {
    const s = await status(tmpDataRoot);
    expect(s.running).toBe(false);
    expect("stale_pid" in s ? s.stale_pid : undefined).toBeUndefined();
  });

  it("reports stale_pid when pidfile points at a dead pid", async () => {
    // pid 999999 is overwhelmingly unlikely to be a live process.
    const paths = daemonPaths(tmpDataRoot);
    await fs.mkdir(path.dirname(paths.pidFile), { recursive: true });
    await fs.writeFile(paths.pidFile, "999999\n");
    const s = await status(tmpDataRoot);
    expect(s.running).toBe(false);
    expect("stale_pid" in s ? s.stale_pid : undefined).toBe(999999);
  });

  it("reports not-running on a malformed pidfile (not a number)", async () => {
    const paths = daemonPaths(tmpDataRoot);
    await fs.mkdir(path.dirname(paths.pidFile), { recursive: true });
    await fs.writeFile(paths.pidFile, "garbage\n");
    const s = await status(tmpDataRoot);
    expect(s.running).toBe(false);
  });
});

describe("stopDaemon (idempotency)", () => {
  it("returns stopped:false when no daemon is running", async () => {
    const res = await stopDaemon({ dataRoot: tmpDataRoot });
    expect(res.stopped).toBe(false);
  });

  it("cleans up a stale pidfile during stop()", async () => {
    const paths = daemonPaths(tmpDataRoot);
    await fs.mkdir(path.dirname(paths.pidFile), { recursive: true });
    await fs.writeFile(paths.pidFile, "999999\n");
    await stopDaemon({ dataRoot: tmpDataRoot });
    // Pidfile should be gone.
    await expect(fs.access(paths.pidFile)).rejects.toThrow();
  });
});

describe("startDaemon + stopDaemon (end-to-end)", () => {
  it("starts, reports running, then stops cleanly", async () => {
    const env = dataRootEnv();
    const startRes = await startDaemon(env);
    expect(startRes.already_running).toBe(false);
    expect(startRes.pid).toBeGreaterThan(0);

    const s = await status(env.dataRoot);
    expect(s.running).toBe(true);
    if (s.running) {
      expect(s.pid).toBe(startRes.pid);
    }

    const stopRes = await stopDaemon({ dataRoot: env.dataRoot });
    expect(stopRes.stopped).toBe(true);
    expect(stopRes.pid).toBe(startRes.pid);

    // Pidfile cleaned up.
    const after = await status(env.dataRoot);
    expect(after.running).toBe(false);
  }, 15000);

  it("is idempotent: a second start() returns already_running:true with the same pid", async () => {
    const env = dataRootEnv();
    const first = await startDaemon(env);
    expect(first.already_running).toBe(false);

    const second = await startDaemon(env);
    expect(second.already_running).toBe(true);
    expect(second.pid).toBe(first.pid);

    await stopDaemon({ dataRoot: env.dataRoot });
  }, 15000);

  it("writes daemon boot lines to the log file", async () => {
    const env = dataRootEnv();
    await startDaemon(env);
    // Give the worker a beat to emit its boot lines.
    await new Promise((r) => setTimeout(r, 600));
    const log = await fs.readFile(daemonPaths(env.dataRoot).logFile, "utf8");
    expect(log).toContain("=== chat-daemon start @");
    expect(log).toContain("worker booted pid=");
    await stopDaemon({ dataRoot: env.dataRoot });
  }, 15000);

  it("survives a stop on a daemon spawned from a different test (stale handling)", async () => {
    const env = dataRootEnv();
    // First start, then kill the process behind status's back so the
    // pidfile becomes stale. Real-world: daemon crashed.
    const first = await startDaemon(env);
    try {
      process.kill(first.pid, "SIGKILL");
    } catch {
      /* race */
    }
    // Wait briefly for the kill to take effect.
    await new Promise((r) => setTimeout(r, 200));
    const s = await status(env.dataRoot);
    expect(s.running).toBe(false);
    // Should NOT throw and should report not-stopped (since it wasn't).
    const stopRes = await stopDaemon({ dataRoot: env.dataRoot });
    expect(stopRes.stopped).toBe(false);
  }, 15000);
});

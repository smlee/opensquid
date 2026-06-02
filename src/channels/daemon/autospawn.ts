/**
 * chat-transport daemon auto-spawn (T-CHAT-AS-TERMINAL CAT.1d).
 *
 * Re-point of the legacy `src.legacy/chat/daemon/autospawn.ts`. The legacy
 * autospawn fired from the legacy MCP server boot (`src.legacy/index.ts`),
 * which is no longer the active server — the live MCP entrypoints are
 * `src/mcp/server.js` + `src/mcp/chat-bridge-server.js` (G.8 wiring). So the
 * NEW chat MCP bridge (`src/mcp/chat-bridge-server.ts`) calls this on boot to
 * opportunistically ensure the NEW chat-transport daemon
 * (`src/channels/daemon/`) is running, so `chat_send` has a socket to dial and
 * inbound Telegram lands in the umbrella inboxes — without the operator having
 * to remember `opensquid chat-daemon start` after every reboot.
 *
 * Behavior (mirrors the legacy contract):
 *   - No-op when no chat platform is configured (`loadChatConfig` → nothing).
 *   - No-op when a daemon is already running.
 *   - Otherwise acquire an atomic spawn-lock (`fs.open(lock, 'wx')`) so two
 *     concurrent MCP servers don't double-spawn; the loser waits briefly for
 *     the winner's pidfile. Stale lock (> 15s) is reclaimed.
 *   - Always async + non-throwing: callers fire-and-forget without try/catch.
 *
 * `startDaemon` (lifecycle.ts) spawns `process.argv[1]` (the running binary,
 * `dist/cli.js`) with the `chat-daemon-worker` token — which `src/cli.ts`
 * short-circuits to `runDaemonWorker()`. The MCP server's `process.argv[1]` is
 * `dist/mcp/chat-bridge-server.js`, NOT `dist/cli.js`, so we override
 * `entrypoint` to the CLI binary (resolved alongside the MCP server in dist/).
 *
 * Imports from: node:fs, node:path, ../config, ../../runtime/paths, ./lifecycle.
 * Imported by: src/mcp/chat-bridge-server.ts (boot) + tests.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadChatConfig } from '../config.js';
import { OPENSQUID_HOME } from '../../runtime/paths.js';

import { startDaemon, status } from './lifecycle.js';

const STALE_LOCK_AGE_MS = 15_000;
const PIDFILE_WAIT_MS = 8_000;
const POLL_INTERVAL_MS = 100;

export interface AutoSpawnResult {
  status: 'spawned' | 'already_running' | 'waited_for_peer' | 'no_config' | 'error';
  pid?: number;
  error?: string;
}

const spawnLockPath = (): string => join(OPENSQUID_HOME(), 'chat-daemon.spawn.lock');

/**
 * Resolve the CLI binary (`dist/cli.js`) so the spawned worker re-invokes the
 * right entrypoint regardless of which binary is doing the autospawn. From the
 * MCP server at `dist/mcp/chat-bridge-server.js`, the CLI sits at `dist/cli.js`
 * — two dirs up + `cli.js`. Honors `OPENSQUID_CLI_ENTRYPOINT` for tests.
 */
export function resolveCliEntrypoint(): string {
  const override = process.env.OPENSQUID_CLI_ENTRYPOINT;
  if (override !== undefined && override.length > 0) return override;
  const here = fileURLToPath(import.meta.url);
  // dist/channels/daemon/autospawn.js → dist → dist/cli.js
  return resolve(dirname(here), '..', '..', 'cli.js');
}

/** True iff at least one chat platform has a token configured. */
async function anyChatConfigured(): Promise<boolean> {
  const config = await loadChatConfig();
  return (
    config.telegram?.bot_token !== undefined ||
    config.discord?.bot_token !== undefined ||
    config.slack?.bot_token !== undefined
  );
}

/**
 * Injection seams for tests — so a unit test can exercise the autospawn FSM
 * WITHOUT reading the developer's real chat config or spawning a live daemon
 * (the live cutover is the operator's job, never the test suite's).
 */
export interface EnsureChatDaemonDeps {
  /** Override the spawned worker's entrypoint (defaults to `dist/cli.js`). */
  entrypoint?: string;
  /** Override the "is any platform configured" probe. */
  isConfigured?: () => Promise<boolean>;
  /** Override the liveness probe (defaults to `lifecycle.status`). */
  statusFn?: typeof status;
  /** Override the spawn (defaults to `lifecycle.startDaemon`). */
  startFn?: typeof startDaemon;
}

/**
 * Best-effort: ensure the chat-transport daemon is running. Returns on the
 * no-op paths (no config, already running, peer-spawning). Never throws.
 */
export async function ensureChatDaemonRunning(
  opts: EnsureChatDaemonDeps = {},
): Promise<AutoSpawnResult> {
  const isConfigured = opts.isConfigured ?? anyChatConfigured;
  const statusFn = opts.statusFn ?? status;
  const startFn = opts.startFn ?? startDaemon;
  try {
    if (!(await isConfigured())) return { status: 'no_config' };

    const cur = await statusFn();
    if (cur.running) return { status: 'already_running', pid: cur.pid };

    const entrypoint = opts.entrypoint ?? resolveCliEntrypoint();
    const lockPath = spawnLockPath();
    const acquired = await tryAcquireLock(lockPath);
    if (acquired) {
      try {
        // Re-check after acquiring the lock — a peer may have finished
        // spawning between our status() and the lock.
        const re = await statusFn();
        if (re.running) return { status: 'already_running', pid: re.pid };
        const res = await startFn({ entrypoint });
        return res.already_running
          ? { status: 'already_running', pid: res.pid }
          : { status: 'spawned', pid: res.pid };
      } finally {
        await fs.unlink(lockPath).catch(() => {
          /* race-tolerant */
        });
      }
    }

    // Another process holds the lock — wait for its pidfile.
    const pid = await waitForPeer(statusFn);
    if (pid !== null) return { status: 'waited_for_peer', pid };
    return { status: 'error', error: 'peer spawn timed out' };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

async function tryAcquireLock(lockPath: string): Promise<boolean> {
  await fs.mkdir(dirname(lockPath), { recursive: true });
  try {
    const fd = await fs.open(lockPath, 'wx');
    await fd.write(`${process.pid}\n`);
    await fd.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lock exists — reclaim it if stale, else yield.
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > STALE_LOCK_AGE_MS) {
        await fs.unlink(lockPath).catch(() => {
          /* race */
        });
        return tryAcquireLock(lockPath);
      }
    } catch {
      // Lock vanished between EEXIST and stat — retry.
      return tryAcquireLock(lockPath);
    }
    return false;
  }
}

async function waitForPeer(statusFn: typeof status): Promise<number | null> {
  const deadline = Date.now() + PIDFILE_WAIT_MS;
  while (Date.now() < deadline) {
    const s = await statusFn();
    if (s.running) return s.pid;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * agent-bridge headless responder autospawn (T-CHAT-AS-TERMINAL CAT.5.1).
 *
 * The chat-transport daemon (`src/channels/daemon/autospawn.ts`) already
 * autospawns from the MCP chat-bridge boot. The HEADLESS RESPONDER — the
 * agent-bridge daemon that ANSWERS chat when no terminal is live (CAT.5 the
 * project umbrella's headless responder, CAT.6 the project-less `general`
 * session) — did NOT. This module mirrors that chat-daemon autospawn so the
 * headless responder is ALWAYS-ON too: started opportunistically on MCP boot,
 * keyed PER-INSTANCE so `loop` + `general` run concurrently (CAT.5.1's
 * per-scope lock/pid in daemon.ts).
 *
 * SAFE to autospawn the project headless even while a terminal is live: CAT.5's
 * lease-ownership guard makes it STAND DOWN. The headless only answers when it
 * owns a fresh umbrella lease; while a human `chat watch` lease is present the
 * dispatcher's flush-time `isLeaseFreshAndOwnedBy` guard suppresses it — it
 * idles at zero token cost (fs-only heartbeat) until the human lease lapses.
 *
 * Behavior (mirrors `ensureChatDaemonRunning`):
 *   - No-op when no chat platform is configured.
 *   - No-op when the SCOPED daemon (its own pidfile) is already running.
 *   - Else acquire an atomic per-scope spawn-lock (`fs.open(lock, 'wx')`) so two
 *     MCP servers don't double-spawn; the loser waits briefly for the pidfile.
 *     Stale lock (> 15s) is reclaimed.
 *   - Always async + non-throwing. A resolution failure (no project uuid / no
 *     pack) → `{ status: 'no_config' }` (skip that scope, never throw).
 *
 * It spawns `dist/cli.js agent-bridge start [--general]` DETACHED:
 *   - general: `agent-bridge start --general` (env as-is — the worker resolves
 *     the built-in `general` pack itself).
 *   - project umbrella: `agent-bridge start` with `OPENSQUID_PROJECT_UUID` +
 *     `OPENSQUID_PACK_ROOT` injected into the child env (resolved exactly like
 *     cli.ts's non-general path: `resolveProjectUuid` + `resolvePackRootFromEnv`).
 *     If the project uuid can't be resolved → skip (no-op).
 *
 * Imports from: node:fs, node:os, node:path, node:child_process, node:url,
 *   ../../channels/config, ../../channels/routing, ../paths, ./daemon.
 * Imported by: src/mcp/chat-bridge-server.ts (boot) + tests.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadChatConfig } from '../../channels/config.js';
import { GENERAL_UMBRELLA } from '../../channels/routing.js';
import { resolveProjectUuid } from '../paths.js';

import {
  agentBridgeLockPath,
  agentBridgePidPath,
  resolvePackRootFromEnv,
  type AgentBridgeScopeKey,
} from './daemon.js';

const STALE_LOCK_AGE_MS = 15_000;
const PIDFILE_WAIT_MS = 8_000;
const POLL_INTERVAL_MS = 100;

export interface AgentBridgeAutoSpawnResult {
  status: 'spawned' | 'already_running' | 'waited_for_peer' | 'no_config' | 'error';
  pid?: number;
  error?: string;
}

/**
 * What to autospawn: either the project-less `general` session, or a project
 * umbrella's headless responder (keyed by umbrella id + cwd → project/pack).
 */
export type EnsureTarget =
  | { kind: 'general' }
  | {
      kind: 'umbrella';
      /** The umbrella the cwd resolves to (CAT.5 — the scope identity). */
      umbrellaId: string;
      /** Working dir to resolve the project uuid / pack root from. */
      cwd: string;
    };

/**
 * Resolve the CLI binary (`dist/cli.js`). From the MCP server at
 * `dist/mcp/chat-bridge-server.js` the CLI sits at `dist/cli.js`; from this
 * module's built location (`dist/runtime/agent_bridge/autospawn.js`) it's three
 * dirs up. We resolve relative to the MCP-server layout to match the chat
 * daemon's `resolveCliEntrypoint`, honoring `OPENSQUID_CLI_ENTRYPOINT`.
 */
export function resolveCliEntrypoint(): string {
  const override = process.env.OPENSQUID_CLI_ENTRYPOINT;
  if (override !== undefined && override.length > 0) return override;
  const here = fileURLToPath(import.meta.url);
  // dist/runtime/agent_bridge/autospawn.js → dist → dist/cli.js
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

/** A pidfile-liveness probe result, scope-keyed. */
export interface ScopedStatus {
  running: boolean;
  pid?: number;
}

/** `kill -0 <pid>` liveness — ESRCH (dead) → false, EPERM (foreign live) → true. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Default scoped-status probe: read `agent-bridge[-<scope>].pid` + `kill -0`. */
async function defaultScopedStatus(scope: AgentBridgeScopeKey): Promise<ScopedStatus> {
  let raw: string;
  try {
    raw = await fs.readFile(agentBridgePidPath(scope), 'utf8');
  } catch {
    return { running: false };
  }
  const pid = parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return { running: false };
  return isProcessAlive(pid) ? { running: true, pid } : { running: false };
}

/** A detached spawn invocation: argv (after the cli entrypoint) + child env. */
export interface SpawnInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Default spawn: detached `node <entrypoint> <args...>` with the merged env. */
function defaultSpawn(
  entrypoint: string,
  inv: SpawnInvocation,
): { pid?: number } {
  const child = spawn(process.execPath, [entrypoint, ...inv.args], {
    detached: true,
    stdio: 'ignore',
    env: inv.env,
  });
  child.unref();
  return child.pid !== undefined ? { pid: child.pid } : {};
}

/**
 * Injection seams for tests — exercise the autospawn FSM WITHOUT reading the
 * developer's real chat config or spawning a live daemon.
 */
export interface EnsureAgentBridgeDeps {
  /** Override the spawned worker's entrypoint (defaults to `dist/cli.js`). */
  entrypoint?: string;
  /** Override the "is any platform configured" probe. */
  isConfigured?: () => Promise<boolean>;
  /** Override the scoped-liveness probe. */
  statusFn?: (scope: AgentBridgeScopeKey) => Promise<ScopedStatus>;
  /** Override the detached spawn. */
  spawnFn?: (entrypoint: string, inv: SpawnInvocation) => { pid?: number };
  /** Override the project-uuid resolver (tests). */
  resolveProjectUuidFn?: (opts: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<string | null>;
  /** Override the pack-root resolver (tests). */
  resolvePackRootFn?: (env?: NodeJS.ProcessEnv) => string;
  /** Override base env threaded into the child (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the detached spawn invocation for a target, or `null` to SKIP (a
 * project umbrella whose project uuid can't be resolved). Pure given its deps.
 */
function buildInvocation(
  target: EnsureTarget,
  deps: Required<Pick<EnsureAgentBridgeDeps, 'resolvePackRootFn' | 'env'>>,
  projectUuid: string | null,
): SpawnInvocation | null {
  if (target.kind === 'general') {
    // General: env as-is; the worker resolves the built-in `general` pack.
    return { args: ['agent-bridge', 'start', '--general'], env: { ...deps.env } };
  }
  // Project umbrella: inject the resolved project uuid + pack root so the
  // detached `agent-bridge start` worker keys off THIS scope (matches cli.ts's
  // non-general path). Skip when the project uuid can't be resolved.
  if (projectUuid === null) return null;
  const packRoot = deps.resolvePackRootFn(deps.env);
  return {
    args: ['agent-bridge', 'start'],
    env: {
      ...deps.env,
      OPENSQUID_PROJECT_UUID: projectUuid,
      OPENSQUID_PACK_ROOT: packRoot,
    },
  };
}

/** Scope key for a target (umbrella id is the scope identity for both kinds). */
function scopeForTarget(target: EnsureTarget): AgentBridgeScopeKey {
  return target.kind === 'general'
    ? { umbrellaId: GENERAL_UMBRELLA }
    : { umbrellaId: target.umbrellaId };
}

/**
 * Best-effort: ensure the headless agent-bridge responder for `target` is
 * running. Returns on the no-op paths (no config, already running, peer
 * spawning, unresolvable scope). NEVER throws.
 */
export async function ensureAgentBridgeRunning(
  target: EnsureTarget,
  opts: EnsureAgentBridgeDeps = {},
): Promise<AgentBridgeAutoSpawnResult> {
  const isConfigured = opts.isConfigured ?? anyChatConfigured;
  const statusFn = opts.statusFn ?? defaultScopedStatus;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const env = opts.env ?? process.env;
  const resolveProjectUuidFn = opts.resolveProjectUuidFn ?? resolveProjectUuid;
  const resolvePackRootFn = opts.resolvePackRootFn ?? resolvePackRootFromEnv;
  try {
    if (!(await isConfigured())) return { status: 'no_config' };

    const scope = scopeForTarget(target);

    // Resolve the project uuid up-front for the umbrella path so we can SKIP
    // (no_config) before touching any lock when it's unresolvable.
    let projectUuid: string | null = null;
    if (target.kind === 'umbrella') {
      projectUuid = await resolveProjectUuidFn({ cwd: target.cwd, env });
      if (projectUuid === null) return { status: 'no_config' };
    }

    const cur = await statusFn(scope);
    if (cur.running) return { status: 'already_running', ...(cur.pid !== undefined ? { pid: cur.pid } : {}) };

    const invocation = buildInvocation(target, { resolvePackRootFn, env }, projectUuid);
    if (invocation === null) return { status: 'no_config' };

    const entrypoint = opts.entrypoint ?? resolveCliEntrypoint();
    const lockPath = agentBridgeLockPath(scope);
    const acquired = await tryAcquireLock(lockPath);
    if (acquired) {
      try {
        const re = await statusFn(scope);
        if (re.running) {
          return { status: 'already_running', ...(re.pid !== undefined ? { pid: re.pid } : {}) };
        }
        const res = spawnFn(entrypoint, invocation);
        return res.pid !== undefined ? { status: 'spawned', pid: res.pid } : { status: 'spawned' };
      } finally {
        await fs.unlink(lockPath).catch(() => {
          /* race-tolerant */
        });
      }
    }

    // Another process holds the lock — wait for its pidfile.
    const pid = await waitForPeer(statusFn, scope);
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
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > STALE_LOCK_AGE_MS) {
        await fs.unlink(lockPath).catch(() => {
          /* race */
        });
        return tryAcquireLock(lockPath);
      }
    } catch {
      return tryAcquireLock(lockPath);
    }
    return false;
  }
}

async function waitForPeer(
  statusFn: (scope: AgentBridgeScopeKey) => Promise<ScopedStatus>,
  scope: AgentBridgeScopeKey,
): Promise<number | null> {
  const deadline = Date.now() + PIDFILE_WAIT_MS;
  while (Date.now() < deadline) {
    const s = await statusFn(scope);
    if (s.running) return s.pid ?? -1;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

/**
 * MCP-boot convenience (CAT.5.1): ensure (a) the GENERAL headless responder
 * (always) and (b) the headless responder for the umbrella the cwd resolves to
 * (if any). Each is fire-and-forget at the call site; this helper awaits both
 * and returns their results for logging. Never throws.
 *
 * `cwd` defaults to `CLAUDE_PROJECT_DIR ?? process.cwd()` (matches the MCP
 * server's active-umbrella resolution). `umbrellaForCwd` lets the caller pass
 * the already-resolved umbrella (the MCP boot resolves it once for logging).
 */
export async function ensureHeadlessRespondersForBoot(opts: {
  /** The umbrella the cwd resolves to (null ⇒ only the general responder). */
  umbrellaForCwd: string | null;
  /** Working dir for the project/pack resolution. */
  cwd?: string;
  /** Test seam — forwarded to each `ensureAgentBridgeRunning`. */
  deps?: EnsureAgentBridgeDeps;
  /** Test seam — override the ensure fn itself (asserts call shape). */
  ensureFn?: typeof ensureAgentBridgeRunning;
}): Promise<{ general: AgentBridgeAutoSpawnResult; umbrella: AgentBridgeAutoSpawnResult | null }> {
  const ensureFn = opts.ensureFn ?? ensureAgentBridgeRunning;
  const cwd = opts.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const general = await ensureFn({ kind: 'general' }, opts.deps);
  let umbrella: AgentBridgeAutoSpawnResult | null = null;
  if (opts.umbrellaForCwd !== null && opts.umbrellaForCwd !== GENERAL_UMBRELLA) {
    umbrella = await ensureFn({ kind: 'umbrella', umbrellaId: opts.umbrellaForCwd, cwd }, opts.deps);
  }
  return { general, umbrella };
}

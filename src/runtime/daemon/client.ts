/**
 * DAEMON.1 — the thin-client side (T-fsm-actor-runtime §DAEMON.1).
 *
 * Hooks / MCP / chat / ralph use this to reach the host. `ensureRunning()` reads
 * `runtime.json`; if it points at a LIVE host (ping ok) it reuses it, else it
 * auto-starts the host and awaits ready — SINGLE MODE, no degraded fallback (the
 * static hardline floor is a separate concern). `send()` POSTs a token-authed
 * envelope to the localhost host.
 *
 * Thundering-herd: N hooks firing at once each try to start — the boot lock in
 * `startHost` (proper-lockfile) collapses them to one host; the losers' lock-throw
 * is absorbed by an await-ready retry that re-reads the now-present `runtime.json`.
 *
 * Borrows gstack's `ensureRunning`/spawn-and-await shape; Node ≥ 20 global `fetch`.
 */
import { spawn } from 'node:child_process';

import type { Envelope } from '../bus/types.js';
import { OPENSQUID_HOME } from '../paths.js';
import { readRuntimeState, type RuntimeState } from './state_file.js';

const PING_TIMEOUT_MS = 1500;
const READY_RETRIES = 40; // ~6s total at 150ms — covers a cold host boot + the herd loser re-read
const READY_INTERVAL_MS = 150;

/** Is the host at this port/token alive? (a dead pid leaves a stale runtime.json) */
export async function ping(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false; // unreachable ⇒ dead/stale
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Spawn the host as a detached child, then poll runtime.json until a live host answers. */
async function spawnHostAndAwaitReady(home: string): Promise<RuntimeState> {
  // The host entry is a tiny compiled module that calls startHost(); detached + unref so the
  // parent (a short-lived hook) can exit without killing the long-lived host.
  const child = spawn(process.execPath, [hostEntryPath()], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OPENSQUID_HOME: home },
  });
  child.unref();
  for (let i = 0; i < READY_RETRIES; i++) {
    const st = await readRuntimeState(home);
    if (st && (await ping(st.port, st.token))) return st;
    await sleep(READY_INTERVAL_MS);
  }
  throw new Error('[opensquid] host did not become ready in time');
}

/** Resolve the host entry module path (the process that calls startHost). */
function hostEntryPath(): string {
  return new URL('./host_entry.js', import.meta.url).pathname;
}

/**
 * Return a live host, auto-starting it when absent/dead. Single mode: there is no
 * degraded "run without a host" path — if we can't reach one, we make one.
 */
export async function ensureRunning(home: string = OPENSQUID_HOME()): Promise<RuntimeState> {
  const st = await readRuntimeState(home);
  if (st && (await ping(st.port, st.token))) return st; // alive → reuse (no second spawn)
  return spawnHostAndAwaitReady(home); // absent/dead → auto-start
}

/** POST an envelope to the host (localhost only, token-authed). */
export async function send(env: Envelope, home: string = OPENSQUID_HOME()): Promise<unknown> {
  const { port, token } = await ensureRunning(home);
  const res = await fetch(`http://127.0.0.1:${port}/envelope`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(env),
  });
  if (!res.ok) throw new Error(`[opensquid] host rejected envelope: ${res.status}`);
  return res.json();
}

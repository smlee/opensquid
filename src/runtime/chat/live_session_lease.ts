/**
 * Live-session lease (Track T-DEL, DEL.1) — the cross-session arbitration
 * primitive. While `opensquid chat watch` runs for a project, it writes +
 * heartbeats a lease file; the always-on agent-bridge daemon reads it (DEL.2)
 * and stays silent while a FRESH lease exists (a live interactive session is
 * handling the project), so the two delivery paths never double-respond.
 *
 * Freshness — not mere existence — is the signal: a crashed `chat watch` leaves
 * a stale lease, and the daemon must resume once it goes stale. So `removeLease`
 * is best-effort cleanup; `isLeaseFresh` is the authority.
 *
 * Imports from: node:fs/promises, ../paths.
 * Imported by: src/runtime/chat/watch_cli.ts (writer/heartbeat),
 *   src/runtime/agent_bridge/dispatcher.ts (reader, DEL.2).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { liveSessionLease } from '../paths.js';

/** A lease older than this is stale → the daemon may respond. */
export const STALE_MS = 90_000;
/** Heartbeat cadence — comfortably under STALE_MS so a live lease never lapses. */
export const HEARTBEAT_MS = 30_000;

export interface LiveSessionLease {
  session_id: string;
  pid: number;
  refreshed_at: string; // ISO-8601
}

/** Resolve a stable session id for the lease (informational; freshness rules). */
export function resolveSessionId(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_SESSION_ID ?? env.OPENSQUID_SESSION_ID ?? `pid-${process.pid}`;
}

export async function writeLease(
  uuid: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  const lease: LiveSessionLease = {
    session_id: sessionId,
    pid: process.pid,
    refreshed_at: now.toISOString(),
  };
  const path = liveSessionLease(uuid);
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await writeFile(path, JSON.stringify(lease), 'utf8');
}

/** Refresh just the timestamp (keeps session_id/pid). */
export async function refreshLease(uuid: string, now: Date = new Date()): Promise<void> {
  const existing = await readLease(uuid);
  await writeLease(uuid, existing?.session_id ?? resolveSessionId(), now);
}

export async function readLease(uuid: string): Promise<LiveSessionLease | null> {
  try {
    const raw = await readFile(liveSessionLease(uuid), 'utf8');
    const parsed = JSON.parse(raw) as LiveSessionLease;
    if (typeof parsed.refreshed_at !== 'string') return null;
    return parsed;
  } catch {
    return null; // absent or malformed ⇒ no live session
  }
}

/** True iff a lease exists AND was refreshed within STALE_MS (clock-forward). */
export function isLeaseFresh(lease: LiveSessionLease | null, now: Date = new Date()): boolean {
  if (lease === null) return false;
  const age = now.getTime() - new Date(lease.refreshed_at).getTime();
  return Number.isFinite(age) && age >= 0 && age < STALE_MS;
}

/** Best-effort removal on `chat watch` exit. Never throws. */
export async function removeLease(uuid: string): Promise<void> {
  await rm(liveSessionLease(uuid), { force: true }).catch(() => undefined);
}

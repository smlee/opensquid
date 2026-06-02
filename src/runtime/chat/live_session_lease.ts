/**
 * Live-session lease (Track T-DEL, DEL.1) — the cross-session arbitration
 * primitive. While `opensquid chat watch` runs for a session, it writes +
 * heartbeats a lease file; the always-on agent-bridge daemon reads it (DEL.2)
 * and stays silent while a FRESH lease exists (a live interactive session is
 * handling the work), so the two delivery paths never double-respond.
 *
 * Freshness — not mere existence — is the signal: a crashed `chat watch` leaves
 * a stale lease, and the daemon must resume once it goes stale. So `removeLease`
 * is best-effort cleanup; `isLeaseFresh` is the authority.
 *
 * KEY-AGNOSTIC (T-CHAT-AS-TERMINAL CAT.1c): the lease functions take the
 * lease-file PATH directly, not a project_uuid. This decouples the lease
 * envelope/freshness logic from how the key resolves to a path, so the chat
 * surfaces can lease per-UMBRELLA (`umbrellaLiveSessionLease(id)`) while the
 * agent-bridge daemon keeps leasing per-project (`liveSessionLease(uuid)`).
 * The caller resolves the path; this module owns only the envelope + I/O.
 *
 * Imports from: node:fs/promises.
 * Imported by: src/runtime/chat/watch_cli.ts (writer/heartbeat, umbrella path),
 *   src/runtime/chat/session_routing.ts (reader, umbrella path),
 *   src/runtime/agent_bridge/dispatcher.ts (reader, project path, DEL.2).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  leasePath: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  const lease: LiveSessionLease = {
    session_id: sessionId,
    pid: process.pid,
    refreshed_at: now.toISOString(),
  };
  await mkdir(dirname(leasePath), { recursive: true }).catch(() => undefined);
  await writeFile(leasePath, JSON.stringify(lease), 'utf8');
}

/** Refresh just the timestamp (keeps session_id/pid). */
export async function refreshLease(leasePath: string, now: Date = new Date()): Promise<void> {
  const existing = await readLease(leasePath);
  await writeLease(leasePath, existing?.session_id ?? resolveSessionId(), now);
}

export async function readLease(leasePath: string): Promise<LiveSessionLease | null> {
  try {
    const raw = await readFile(leasePath, 'utf8');
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

/**
 * Ownership-aware freshness (T-CHAT-AS-TERMINAL CAT.5). True iff the lease is
 * fresh AND owned by `expectedSessionId`. This is the double-holder guard: a
 * headless daemon answers an inbound ONLY when it both holds a fresh lease and
 * that lease carries ITS OWN session id — never while a human (or any other)
 * session holds a fresh lease, which would double-answer (409 / mingling).
 *
 * `isLeaseFresh` alone answers "is SOMEONE live?"; this answers "are WE live?".
 */
export function isLeaseFreshAndOwnedBy(
  lease: LiveSessionLease | null,
  expectedSessionId: string,
  now: Date = new Date(),
): boolean {
  if (!isLeaseFresh(lease, now)) return false;
  return lease !== null && lease.session_id === expectedSessionId;
}

/** Best-effort removal on `chat watch` exit. Never throws. */
export async function removeLease(leasePath: string): Promise<void> {
  await rm(leasePath, { force: true }).catch(() => undefined);
}

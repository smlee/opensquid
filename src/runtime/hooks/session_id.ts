/**
 * Session-id resolution for hook binaries + the `.current-session` pointer.
 *
 * ROOT-CAUSE FIX (2026-05-26): the `stop` / `user-prompt-submit` /
 * `pre-tool-use` hooks previously read the session id ONLY from
 * `process.env.CLAUDE_SESSION_ID`, which Claude Code does not reliably set —
 * it delivers `session_id` in the hook's stdin JSON payload (per the CC hook
 * contract). The result: every session collapsed to the literal `'unknown'`
 * bucket, so per-session state (the automation flag, the per-turn tool ledger)
 * never keyed on the real session. `session-end.ts` was the only hook reading
 * stdin correctly. `extractSessionId` centralizes the correct precedence:
 * stdin `session_id` (snake) → `sessionId` (camel) → `CLAUDE_SESSION_ID` env
 * (last-resort) → `'unknown'`.
 *
 * `.current-session` (at `OPENSQUID_HOME()/.current-session`) lets an
 * out-of-band process — notably the `opensquid automation on|off` CLI run from
 * a terminal that never receives the hook stdin — discover the live session id.
 * The `user-prompt-submit` hook records it every turn (best-effort).
 *
 * Imports from: node:fs/promises, node:path, ../paths.js.
 * Imported by: hooks/{stop,user-prompt-submit,pre-tool-use}.ts (resolve +
 *   record); setup/cli/automation.ts (read).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OPENSQUID_HOME } from '../paths.js';

interface SessionIdCarrier {
  session_id?: unknown;
  sessionId?: unknown;
}

/**
 * Resolve the session id from a hook's raw stdin string. Precedence:
 * stdin `session_id` → stdin `sessionId` → `CLAUDE_SESSION_ID` env → `'unknown'`.
 * Never throws: a malformed/empty payload falls straight through to the env /
 * `'unknown'` fallback so the calling hook stays fail-open.
 */
export function extractSessionId(raw: string): string {
  let obj: SessionIdCarrier = {};
  try {
    obj = JSON.parse(raw) as SessionIdCarrier;
  } catch {
    // fall through to env / 'unknown'
  }
  if (typeof obj.session_id === 'string' && obj.session_id !== '') return obj.session_id;
  if (typeof obj.sessionId === 'string' && obj.sessionId !== '') return obj.sessionId;
  const env = process.env.CLAUDE_SESSION_ID;
  if (env !== undefined && env !== '') return env;
  return 'unknown';
}

/** Absolute path of the live-session pointer file. */
export const currentSessionPath = (): string => join(OPENSQUID_HOME(), '.current-session');

/**
 * Record the live session id so out-of-band processes (the automation CLI) can
 * target the session the hooks actually see. Best-effort: never throws, and
 * never records the `'unknown'` sentinel (that would mislead the CLI).
 */
export async function recordCurrentSession(sessionId: string): Promise<void> {
  if (sessionId === 'unknown' || sessionId === '') return;
  try {
    await mkdir(OPENSQUID_HOME(), { recursive: true });
    await writeFile(currentSessionPath(), sessionId, 'utf-8');
  } catch {
    // best-effort: a write failure must never break the hook
  }
}

/** Read the live session id, or `null` if the pointer is absent/unreadable/empty. */
export async function readCurrentSession(): Promise<string | null> {
  try {
    const raw = (await readFile(currentSessionPath(), 'utf-8')).trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * T-MULTISESSION MS.1 (2026-05-29) — env-first session resolution for MCP
 * tools. Each Claude Code session spawns its own MCP server process; when
 * Claude Code sets `CLAUDE_SESSION_ID` in that process's env, the MCP server
 * resolves its session id directly (race-free) instead of reading the
 * global `.current-session` pointer (which is overwritten by every
 * concurrent Claude Code session's PreToolUse hook — last writer wins).
 *
 * Precedent for env-first session resolution:
 * - `src/runtime/chat/live_session_lease.ts:resolveSessionId`
 * - `src/mcp/chat_bridge_subscriber.ts:279`
 *
 * Fallback chain:
 *   1. `process.env.CLAUDE_SESSION_ID` (preferred — Claude Code sets per process)
 *   2. `process.env.OPENSQUID_SESSION_ID` (override / test seam)
 *   3. `readCurrentSession()` (existing pointer; cross-session-racing but
 *      backwards-compatible for single-session use)
 */
export async function resolveMcpSessionId(): Promise<string | null> {
  const fromClaudeEnv = process.env.CLAUDE_SESSION_ID;
  if (fromClaudeEnv !== undefined && fromClaudeEnv.length > 0) return fromClaudeEnv;
  const fromOpensquidEnv = process.env.OPENSQUID_SESSION_ID;
  if (fromOpensquidEnv !== undefined && fromOpensquidEnv.length > 0) return fromOpensquidEnv;
  return readCurrentSession();
}

/**
 * `opensquid hook session-end` — Claude Code SessionEnd hook handler.
 *
 * Fires when a Claude Code session terminates. Wipes the session's
 * honesty-ledger state (turn-ledger.jsonl + broken-promises.jsonl) so
 * the ledger doesn't grow unbounded across all-time sessions.
 *
 * Without this hook, every Claude Code session creates a
 * <data-root>/sessions/<id>/ directory with two JSONL files that
 * never get cleaned up. Disk usage grows linearly with session count.
 *
 * Exit 0 always — SessionEnd is cleanup, not blocking.
 */

import { clearSession } from "./honesty-ledger.js";

interface SessionEndInput {
  session_id?: string;
}

export async function runSessionEndHook(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  if (!raw.trim()) process.exit(0);

  let payload: SessionEndInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  if (!sessionId) process.exit(0);

  try {
    await clearSession(sessionId);
  } catch (err) {
    // Cleanup failure is non-fatal — disk-space leak, not a correctness bug.
    process.stderr.write(
      `[opensquid hook session-end] clearSession failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }

  process.exit(0);
}

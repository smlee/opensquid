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

import { runDriftCatalogScan } from "./drift-catalog.js";
import { clearSession } from "./honesty-ledger.js";

interface SessionEndInput {
  session_id?: string;
  /** 0.7.22 / D10: provided by Claude Code's hook payload. Used to
   * resolve which project the catalog entries belong to. */
  transcript_path?: string;
  cwd?: string;
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

  // 0.7.22 / D10 — automated drift catalog. Scan the transcript for
  // drift markers (user corrections, locked-rule citations, agent
  // mea-culpas) and append to the project's drift-catalog.jsonl. Runs
  // BEFORE clearSession so any session-scoped state used for context
  // is still available.
  try {
    const count = await runDriftCatalogScan({
      sessionId,
      transcriptPath: payload.transcript_path,
      cwd: payload.cwd,
    });
    if (count > 0) {
      process.stderr.write(`🦑 [opensquid drift-catalog] recorded ${count} drift marker(s)\n`);
    }
  } catch (err) {
    process.stderr.write(
      `[opensquid hook session-end] drift-catalog scan failed (non-fatal): ${err instanceof Error ? err.message : err}\n`,
    );
  }

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

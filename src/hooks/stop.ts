/**
 * `opensquid hook stop` — Claude Code Stop hook handler.
 *
 * Fires at the end of every assistant turn. Two responsibilities:
 *
 *   1. Honesty ledger reconciliation: cross-reference the assistant's
 *      final message against the session's accumulated tool-call ledger.
 *      Any unfulfilled claim is recorded as a broken promise that the
 *      next turn's UserPromptSubmit hook surfaces back to the agent.
 *
 *   2. Token-threshold heartbeat: estimate transcript token count, and
 *      if the conversation has grown past the configured threshold
 *      since the last checkpoint, arm a pending heartbeat marker so
 *      the next UserPromptSubmit hook injects a re-anchor nudge into
 *      the agent's context. The agent (already authenticated and in
 *      the loop) does the actual recall + classify work inline.
 *
 * Exit 0 always — Stop hook is observational, not blocking.
 *
 * Wired in ~/.claude/settings.json:
 *
 *   "Stop": [
 *     { "hooks": [{
 *       "type": "command",
 *       "command": "node /path/to/opensquid/dist/index.js hook stop"
 *     }] }
 *   ]
 *
 * Pre-#124: this hook also spawned a detached LLM-classifier subprocess.
 * Removed in favor of the heartbeat path — opensquid stays in-MCP-ecosystem
 * (no external LLM dependency, no subprocess), and the agent does the
 * classification work inline per CLAUDE.md classify-and-act rules.
 */

import {
  clearTurnLedger,
  reconcile,
  readBrokenPromises,
  readTurnLedger,
  recordBrokenPromise,
  type BrokenPromise,
} from "./honesty-ledger.js";
import { checkAndMaybeArm } from "./heartbeat.js";
import { checkInlineReportFormat } from "./inline-report-check.js";
import { readLastAssistantText } from "./transcript.js";

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
}

export async function runStopHook(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  if (!raw.trim()) {
    process.exit(0);
  }
  let payload: StopHookInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write("[opensquid hook stop] malformed input — proceeding\n");
    process.exit(0);
  }

  const sessionId = payload.session_id;
  if (!sessionId) process.exit(0);

  // -- (1) Honesty-ledger reconcile ----------------------------------
  const assistantText = payload.transcript_path
    ? await readLastAssistantText(payload.transcript_path)
    : "";

  const ledger = await readTurnLedger(sessionId);
  const broken = reconcile(assistantText, ledger);

  const existing = await readBrokenPromises(sessionId);
  const existingKeys = new Set(existing.map((p) => `${p.claim_id}|${p.matched_text}`));
  const fresh: BrokenPromise[] = [];
  for (const promise of broken) {
    const key = `${promise.claim_id}|${promise.matched_text}`;
    if (existingKeys.has(key)) continue;
    fresh.push(promise);
    try {
      await recordBrokenPromise(sessionId, promise);
    } catch (err) {
      process.stderr.write(
        `[opensquid hook stop] failed to record promise: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  if (fresh.length > 0) {
    for (const p of fresh) {
      process.stderr.write(`🦑 [opensquid honesty] ${p.claim_id}: ${p.reason}\n`);
    }
  }

  // 0.7.30 / D3 follow-up — when the agent writes a completion-report-
  // shaped status update inline (vs. via mcp__opensquid__chat_send),
  // D3's chat_send check doesn't fire. Catch the inline case here at
  // Stop time and surface as a broken-promise next turn.
  if (assistantText) {
    const inlineViolation = checkInlineReportFormat(assistantText);
    if (inlineViolation) {
      const broken: BrokenPromise = {
        ts: new Date().toISOString(),
        claim_id: "inline-report-missing-phases",
        claim_label: "PHASES block per [[feedback_telegram_reports]]",
        matched_text: inlineViolation.matched_text,
        reason:
          `inline message shape suggests a completion report ` +
          `(version_refs=${inlineViolation.signals.version_refs}, ` +
          `commit_hashes=${inlineViolation.signals.hash_refs}) but the ` +
          `PHASES heading is missing. Catches D3 inline variant.`,
      };
      try {
        await recordBrokenPromise(sessionId, broken);
        process.stderr.write(`🦑 [opensquid honesty] ${broken.claim_id}: ${broken.reason}\n`);
      } catch (err) {
        process.stderr.write(
          `[opensquid hook stop] inline-report check write failed: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
  }

  // 0.7.8 (#162): clear the turn-ledger AFTER reconciliation so the
  // next turn's claims reconcile against ONLY that turn's tool calls.
  // Previously the ledger only cleared at SessionEnd, which meant
  // yesterday's git push satisfied today's "I'll push" claim on long
  // resumed sessions — the load-bearing #160 finding for ledger drift.
  try {
    await clearTurnLedger(sessionId);
  } catch (err) {
    process.stderr.write(
      `[opensquid hook stop] turn-ledger clear failed (non-fatal): ${err instanceof Error ? err.message : err}\n`,
    );
  }

  // -- (2) Token-threshold heartbeat ---------------------------------
  if (payload.transcript_path) {
    try {
      const armed = await checkAndMaybeArm(sessionId, payload.transcript_path);
      if (armed) {
        // Surface to stderr too so the user sees that opensquid noticed
        // drift (in addition to the agent seeing it next turn via UPS).
        process.stderr.write(`🦑 [opensquid heartbeat-armed] ${armed}\n`);
      }
    } catch (err) {
      process.stderr.write(
        `[opensquid hook stop] heartbeat check failed (non-fatal): ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  process.exit(0);
}

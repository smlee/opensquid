/**
 * `opensquid hook stop` — Claude Code Stop hook handler.
 *
 * Fires at the end of every assistant turn. Reads the per-turn tool-
 * call ledger (recorded by PreToolUse), reads the assistant's final
 * message from the transcript JSONL, reconciles claims against the
 * ledger, writes any broken promises to the session's append-only
 * ledger. Clears the per-turn ledger when done.
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
 */

import { promises as fs } from "node:fs";

import {
  reconcile,
  readBrokenPromises,
  readTurnLedger,
  recordBrokenPromise,
  type BrokenPromise,
} from "./honesty-ledger.js";

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  // Other fields ignored.
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

  // Read the assistant's last message from the transcript JSONL.
  const assistantText = payload.transcript_path
    ? await readLastAssistantText(payload.transcript_path)
    : "";

  // Cross-reference claims against the SESSION ledger — every tool
  // call from any turn in this session counts as evidence. Recap text
  // describing prior-turn work is correctly NOT flagged.
  const ledger = await readTurnLedger(sessionId);
  const broken = reconcile(assistantText, ledger);

  // De-dupe: don't re-record a broken promise that's already in this
  // session's ledger (avoids the stuck-broken-promise loop where the
  // same claim text recurs across turns).
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

  // Surface only the fresh broken promises (not previously-recorded
  // ones still sitting in the file).
  if (fresh.length > 0) {
    for (const p of fresh) {
      process.stderr.write(`🦑 [opensquid honesty] ${p.claim_id}: ${p.reason}\n`);
    }
  }

  // Session ledger is NOT cleared here — see honesty-ledger.ts
  // `clearTurnLedger` doc-comment. Cleared at session end.
  process.exit(0);
}

/**
 * Read the most recent assistant message text from a Claude Code
 * transcript JSONL. Returns empty string on any failure.
 *
 * Each line is one event; assistant text shows up as
 * `{ "type": "assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }`.
 */
async function readLastAssistantText(transcriptPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]) as TranscriptEvent;
      if (event.type !== "assistant") continue;
      const text = extractAssistantText(event);
      if (text) return text;
    } catch {
      continue;
    }
  }
  return "";
}

interface TranscriptEvent {
  type?: string;
  message?: {
    content?: unknown;
  };
}

function extractAssistantText(event: TranscriptEvent): string {
  const content = event.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

export { readLastAssistantText };

/**
 * `opensquid hook user-prompt-submit` — Claude Code UserPromptSubmit
 * hook handler.
 *
 * Fires when the user submits a prompt (start of every new turn).
 * Surfaces TWO accumulator surfaces via stdout so the agent sees them
 * in its system context:
 *
 *   1. broken-promises.jsonl — claims from the prior assistant turn
 *      that the honesty ledger flagged as unfulfilled.
 *   2. heartbeat-pending.txt — token-threshold re-anchor nudge written
 *      by the Stop hook when the transcript grew past the configured
 *      threshold (default 20K tokens, OPENSQUID_HEARTBEAT_TOKENS).
 *
 * Both surfaces are CLEARED after surfacing — one chance per item per
 * session, no infinite nagging.
 *
 * Exit 0 always — UserPromptSubmit is observational.
 *
 * Pre-#124: this hook also surfaced auto-classify-candidates.jsonl
 * written by a detached LLM subprocess. Removed alongside the auto-
 * classifier deletion — the agent classifies utterances inline per
 * CLAUDE.md, and the heartbeat reminds it to re-anchor periodically.
 */

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";
import { consumePendingHeartbeat } from "./heartbeat.js";
import { type BrokenPromise } from "./honesty-ledger.js";

interface UserPromptSubmitInput {
  session_id?: string;
  prompt?: string;
}

export async function runUserPromptSubmitHook(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  if (!raw.trim()) process.exit(0);

  let payload: UserPromptSubmitInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const sessionId = payload.session_id;
  if (!sessionId) process.exit(0);

  const out: string[] = [];

  // #112-audit finding 1: read+clear is racy if a writer appends concurrently.
  // Rename-then-read atomically claims the file contents — any bytes that
  // arrive after the rename land in a fresh file the next consumer will pick up.
  const broken = await consumeJsonl<BrokenPromise>(
    path.join(resolveDataRoot(), "sessions", sessionId, "broken-promises.jsonl"),
  );
  if (broken.length > 0) {
    out.push("🦑 [opensquid honesty-ledger] unresolved claims from the previous turn:");
    for (const p of broken) {
      out.push(`  🦑 ${p.claim_id}: "${p.matched_text}" — needed ${p.claim_label}`);
    }
    out.push(
      "Acknowledge these in your reply: either do the missing action now, or " +
        "retract the claim explicitly. Don't repeat the pattern.",
    );
  }

  // #124: heartbeat nudge surfaces here when Stop hook armed one. The agent
  // sees this at the top of its context for the new turn and acts on it
  // inline (calls recall, scans for substantive recent user turns, calls
  // memorize/remember/promote per CLAUDE.md classify-and-act).
  const heartbeat = await consumePendingHeartbeat(sessionId);
  if (heartbeat) {
    if (out.length > 0) out.push("");
    out.push(heartbeat);
  }

  if (out.length > 0) {
    process.stdout.write(out.join("\n") + "\n");
  }

  process.exit(0);
}

/**
 * Atomically claim a JSONL accumulator file: rename it to a unique
 * sibling, then read+parse, then delete the renamed file. Any writer
 * that opens the original path after the rename starts a fresh file
 * that the next consumer will pick up.
 */
async function consumeJsonl<T>(filePath: string): Promise<T[]> {
  const claimed = `${filePath}.consuming.${crypto.randomUUID()}`;
  try {
    await fs.rename(filePath, claimed);
  } catch {
    // ENOENT — nothing to consume
    return [];
  }
  let raw: string;
  try {
    raw = await fs.readFile(claimed, "utf8");
  } catch {
    raw = "";
  }
  try {
    await fs.rm(claimed);
  } catch {
    // already gone
  }
  if (!raw.trim()) return [];
  const items: T[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      items.push(JSON.parse(t) as T);
    } catch {
      // skip malformed line
    }
  }
  return items;
}

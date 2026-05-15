/**
 * `opensquid hook user-prompt-submit` — Claude Code UserPromptSubmit
 * hook handler.
 *
 * Fires when the user submits a prompt (start of every new turn).
 * Surfaces TWO accumulator files via stdout so the agent sees them in
 * its context:
 *
 *   1. broken-promises.jsonl — claims from the prior assistant turn
 *      that the honesty ledger flagged as unfulfilled.
 *   2. auto-classify-candidates.jsonl — items the LLM classifier
 *      identified in the user's prior turn (auto-memorized facts
 *      surfaced as FYI, plus surfaced candidates the agent should
 *      consider acting on).
 *
 * Both files are CLEARED after surfacing — one chance per item per
 * session, no infinite nagging.
 *
 * Exit 0 always — UserPromptSubmit is observational.
 */

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";
import { type AutoClassifyCandidate } from "./auto-classify.js";
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

  // #112-audit finding 1: read+clear is racy if a detached subprocess
  // appends concurrently. Rename-then-read atomically claims the file
  // contents — any bytes the subprocess writes after the rename land
  // in a fresh file that the NEXT UserPromptSubmit will surface.
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

  const candidates = await consumeJsonl<AutoClassifyCandidate>(
    path.join(resolveDataRoot(), "sessions", sessionId, "auto-classify-candidates.jsonl"),
  );
  if (candidates.length > 0) {
    if (out.length > 0) out.push("");
    out.push("🦑 [opensquid auto-classify] surfaced from your previous message:");
    for (const c of candidates) {
      out.push(formatCandidate(c));
    }
    out.push(
      "Auto-memorized items are already stored. Surfaced items are candidates — " +
        "call the suggested tool yourself if appropriate.",
    );
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

function formatCandidate(c: AutoClassifyCandidate): string {
  const tag = c.action_taken === "auto-memorized" ? "✅ memorized" : "💡 candidate";
  const memSuffix = c.memory_id ? ` (${c.memory_id})` : "";
  return `  🦑 ${tag} [${c.kind}/${c.confidence}] → ${c.suggested_tool}: "${truncate(c.text, 80)}"${memSuffix}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * `opensquid hook user-prompt-submit` — Claude Code UserPromptSubmit
 * hook handler.
 *
 * Fires when the user submits a prompt (start of every new turn).
 * Reads the session's broken-promise ledger (written by the Stop hook
 * after the previous turn) and surfaces any unresolved entries to the
 * agent via stdout — Claude Code shows hook stdout to the agent.
 *
 * Once surfaced, the ledger is cleared so the agent gets one chance to
 * acknowledge each lie per session.
 *
 * Exit 0 always — UserPromptSubmit is observational.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";
import { readBrokenPromises } from "./honesty-ledger.js";

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

  const broken = await readBrokenPromises(sessionId);
  if (broken.length === 0) process.exit(0);

  // Emit a tight summary the agent will see in its context.
  const lines: string[] = [
    "🦑 [opensquid honesty-ledger] unresolved claims from the previous turn:",
  ];
  for (const p of broken) {
    lines.push(`  🦑 ${p.claim_id}: "${p.matched_text}" — needed ${p.claim_label}`);
  }
  lines.push(
    "Acknowledge these in your reply: either do the missing action now, or " +
      "retract the claim explicitly. Don't repeat the pattern.",
  );
  process.stdout.write(lines.join("\n") + "\n");

  // Clear the ledger — one surface per claim, not infinite nagging.
  await clearBrokenPromises(sessionId);

  process.exit(0);
}

async function clearBrokenPromises(sessionId: string): Promise<void> {
  const p = path.join(resolveDataRoot(), "sessions", sessionId, "broken-promises.jsonl");
  try {
    await fs.rm(p);
  } catch {
    // already gone, fine
  }
}

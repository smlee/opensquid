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
import { consumePendingHeartbeat, markRecallRequired } from "./heartbeat.js";
import { type BrokenPromise } from "./honesty-ledger.js";

/**
 * 0.7.10 (#164): minimum gap between consecutive UserPromptSubmit
 * firings before we consider the session "resumed" rather than
 * continuous. 5 minutes is short enough that a coffee-break doesn't
 * trigger, long enough that genuine process restarts always do.
 */
const RESUME_GAP_MS = 5 * 60 * 1000;

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

  // 0.7.10 (#164): detect resumed sessions and inject a re-anchor
  // prompt. The signal is "gap since last UPS firing for this session
  // > RESUME_GAP_MS." First firing ever writes the marker without
  // injecting (the session just started; no resume happened yet).
  const resumeMsg = await detectResumeAndUpdateMarker(sessionId);
  if (resumeMsg) out.push(resumeMsg);

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
  // 0.7.27 / D8 — surface a plan-mirror reminder when the user's
  // prompt contains multiple task identifiers in sequence. Catches the
  // "166 then 168" → agent does 166 + defers 168 misread.
  if (typeof payload.prompt === "string") {
    const mirror = detectMultiTaskDirective(payload.prompt);
    if (mirror) {
      if (out.length > 0) out.push("");
      out.push(mirror);
    }
  }

  const heartbeat = await consumePendingHeartbeat(sessionId);
  if (heartbeat) {
    if (out.length > 0) out.push("");
    out.push(heartbeat);
    // 0.7.26 / D7 — set the recall-required flag. pre-tool-use will
    // block any mcp__opensquid__* tool call (other than recall) until
    // the agent actually calls recall. Catches the "heartbeat fires,
    // agent acknowledges, continues without complying" drift.
    try {
      await markRecallRequired(sessionId);
    } catch (err) {
      process.stderr.write(
        `[opensquid hook user-prompt-submit] markRecallRequired failed (non-fatal): ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }

  if (out.length > 0) {
    process.stdout.write(out.join("\n") + "\n");
  }

  process.exit(0);
}

/**
 * 0.7.27 / D8 — detect a multi-task directive in the user's prompt
 * and return a "mirror back your parsed plan" reminder message.
 *
 * Trigger patterns (case-insensitive):
 *   - "<num1> then <num2>" — bare-number sequencing (the D8 incident
 *     shape: user said "166 then 168" — agent did 166 + deferred 168)
 *   - "first <ref> then <ref>"
 *   - "after <ref> do <ref>" / "after X then Y"
 *   - Two or more `#<num>` references
 *
 * Returns the surface message when a match fires, null otherwise.
 * Exported for direct testing.
 */
export function detectMultiTaskDirective(prompt: string): string | null {
  const refs = extractTaskRefs(prompt);
  if (refs.length < 2) return null;
  return (
    `🦑 [opensquid] multi-task directive detected (refs: ${refs.slice(0, 5).join(", ")}). ` +
    `Per [[feedback_user_words_have_top_weight]] + drift D8: BEFORE executing, ` +
    `mirror back your parsed plan ("read as: do X, then do Y") so we catch a ` +
    `misread before it ships. Don't auto-defer items the user listed in parallel.`
  );
}

/**
 * Extract probable task references from a user prompt. Returns the
 * distinct references in document order, capped at 10.
 *
 * Heuristics (intentionally narrow to keep false-positives low):
 *   - `#\d+` shapes always count
 *   - bare 2-4-digit numbers count IF they're connected by a
 *     sequencing word ("then" / "after" / "first" / "and then")
 *
 * Exported for testing.
 */
export function extractTaskRefs(prompt: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  // Pass 1: explicit #N references
  for (const m of prompt.matchAll(/#\d+/g)) {
    if (!seen.has(m[0])) {
      refs.push(m[0]);
      seen.add(m[0]);
    }
  }
  // Pass 2: bare-number sequences via "then" / "after" / "first ... then"
  // Pattern: two 2-4-digit numbers separated by "then"/"after"/"and then".
  for (const m of prompt.matchAll(
    /\b(\d{2,4})\s*(?:,\s*|\s+(?:then|after|and then|and)\s+)(\d{2,4})\b/gi,
  )) {
    for (const num of [m[1], m[2]]) {
      const key = `#${num}`;
      if (!seen.has(key)) {
        refs.push(key);
        seen.add(key);
      }
    }
  }
  return refs.slice(0, 10);
}

/**
 * 0.7.10 (#164): detect resumed sessions by tracking the wall-clock
 * gap between consecutive UPS firings. Returns a re-anchor message
 * when a gap exceeds RESUME_GAP_MS, OR null when continuous /
 * first-ever firing.
 *
 * Marker file: ~/.opensquid/sessions/<sid>/ups-last-at.txt
 *   Contents: ISO 8601 timestamp of the last UPS firing.
 *
 * On EVERY call: read prior timestamp → write current timestamp.
 * First call: marker missing → write current; return null (no resume
 * happened, just the session starting).
 * Subsequent call: gap < RESUME_GAP_MS → continuous (return null).
 * Subsequent call: gap >= RESUME_GAP_MS → resumed (return message).
 *
 * Exported for direct testing.
 */
export async function detectResumeAndUpdateMarker(
  sessionId: string,
  options: { dataRoot?: string; now?: number } = {},
): Promise<string | null> {
  const root = resolveDataRoot(options.dataRoot);
  const dir = path.join(root, "sessions", sessionId);
  const markerPath = path.join(dir, "ups-last-at.txt");
  const nowMs = options.now ?? Date.now();

  let prior: number | null = null;
  try {
    const raw = (await fs.readFile(markerPath, "utf8")).trim();
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) prior = parsed;
  } catch {
    /* no marker — first firing */
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(markerPath, new Date(nowMs).toISOString() + "\n", "utf8");

  if (prior === null) return null; // first firing for this session
  const gapMs = nowMs - prior;
  if (gapMs < RESUME_GAP_MS) return null;

  const gapMin = Math.round(gapMs / 60000);
  return (
    `🦑 [opensquid] Session resumed (${gapMin}m since last activity). ` +
    `Before continuing, re-anchor: call \`recall\` for the active task, ` +
    `scan recent assistant turns for any unfulfilled commitments, and ` +
    `re-read any locked rule the next action would touch.`
  );
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

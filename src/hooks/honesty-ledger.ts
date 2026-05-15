/**
 * Honesty ledger — catches claim-vs-action gaps in assistant turns.
 *
 * The agent makes claims like "running tests now" or "starting research"
 * or "committed" in its text output. These claims are checkable against
 * the tool calls that actually happened in the same turn. When the
 * claim has no matching tool call, that's a "broken promise" — opensquid
 * records it so the next turn surfaces it to the agent for correction.
 *
 * Storage:
 *   <data-root>/sessions/<session-id>/turn-ledger.jsonl
 *     One JSON line per tool call this turn, appended by the PreToolUse
 *     hook. Cleared at turn-end after reconciliation.
 *
 *   <data-root>/sessions/<session-id>/broken-promises.jsonl
 *     Append-only ledger of claims that lacked matching evidence.
 *     Surfaced to the agent on the NEXT turn via SessionStart/
 *     UserPromptSubmit hook output.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveDataRoot } from "../codex/store.js";

// ---------------------------------------------------------------------
// Claim → required-evidence catalog
// ---------------------------------------------------------------------

export type ClaimEvidenceShape =
  | { kind: "any_tool" }
  | { kind: "bash_contains"; needle: string }
  | { kind: "bash_regex"; pattern: string }
  | { kind: "tool_called"; tool: string };

export interface ClaimPattern {
  /** Stable id (e.g. "research-start"). */
  id: string;
  /** Regex matched against assistant text. */
  text_regex: string;
  /** What proof of action satisfies this claim. */
  evidence: ClaimEvidenceShape;
  /** Short label surfaced to the agent when the promise is broken. */
  promise_label: string;
}

/**
 * Catalog of common claim phrases observed in the 2026-05-15 build
 * session. Each pattern is conservative — false positive cost is
 * "the agent gets nagged once" while false negative cost is
 * "the lie slips through."
 */
export const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    id: "research-start",
    text_regex: "\\b(pre-?research|research)\\s+(starting|begins?)\\b",
    evidence: { kind: "tool_called", tool: "Agent" },
    promise_label: "spawn a research agent or do explicit reading",
  },
  {
    id: "research-spawning",
    text_regex: "\\bspawn(?:ing)?\\s+(?:a\\s+)?(?:research\\s+)?agent\\b",
    evidence: { kind: "tool_called", tool: "Agent" },
    promise_label: "spawn a research agent",
  },
  {
    id: "starting-now",
    text_regex: "\\b(?:starting|kicking off)\\s+(?:#?\\w+\\s+)?now\\b",
    evidence: { kind: "any_tool" },
    promise_label: "actually start the work (any tool call counts)",
  },
  {
    id: "running-tests",
    text_regex: "\\brunning\\s+(?:the\\s+)?tests?\\b|\\btests?\\s+pass(?:ing|ed|es)?\\b",
    evidence: { kind: "bash_regex", pattern: "(npm\\s+test|cargo\\s+test|vitest|jest)" },
    promise_label: "run npm test / cargo test",
  },
  {
    id: "running-build",
    text_regex:
      "\\brunning\\s+(?:the\\s+)?build\\b|\\bbuild\\s+(?:pass(?:ing|es|ed)?|clean|green)\\b",
    evidence: { kind: "bash_regex", pattern: "(npm\\s+run\\s+build|cargo\\s+build|tsc)" },
    promise_label: "run the build",
  },
  {
    id: "committed",
    text_regex: "\\b(?:committed|just committed|committing)\\b",
    evidence: { kind: "bash_regex", pattern: "git\\s+commit\\b" },
    promise_label: "git commit",
  },
  {
    id: "audit-done",
    text_regex: "\\b(?:audit\\s+(?:done|complete|✅)|Phase\\s+\\d+\\s*[—-]\\s*Audit)\\b",
    evidence: { kind: "any_tool" },
    promise_label: "do the audit (any inspection tool call)",
  },
];

// ---------------------------------------------------------------------
// Per-turn ledger
// ---------------------------------------------------------------------

export interface TurnLedgerEntry {
  ts: string;
  tool: string;
  /** Subset of tool_input relevant to reconciliation. */
  input_summary: string;
}

function sessionDir(sessionId: string, dataRoot?: string): string {
  return path.join(resolveDataRoot(dataRoot), "sessions", sessionId);
}

function ledgerPath(sessionId: string, dataRoot?: string): string {
  return path.join(sessionDir(sessionId, dataRoot), "turn-ledger.jsonl");
}

function brokenPromisesPath(sessionId: string, dataRoot?: string): string {
  return path.join(sessionDir(sessionId, dataRoot), "broken-promises.jsonl");
}

/** Called by PreToolUse hook to record what the agent is about to do. */
export async function recordToolCall(
  sessionId: string,
  tool: string,
  inputSummary: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const dir = sessionDir(sessionId, options.dataRoot);
  await fs.mkdir(dir, { recursive: true });
  const entry: TurnLedgerEntry = {
    ts: new Date().toISOString(),
    tool,
    input_summary: inputSummary,
  };
  await fs.appendFile(
    ledgerPath(sessionId, options.dataRoot),
    JSON.stringify(entry) + "\n",
    "utf8",
  );
}

/** Read the current turn's ledger entries. */
export async function readTurnLedger(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<TurnLedgerEntry[]> {
  try {
    const raw = await fs.readFile(ledgerPath(sessionId, options.dataRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as TurnLedgerEntry);
  } catch {
    return [];
  }
}

/** Clear the ledger after Stop-hook reconciliation. */
export async function clearTurnLedger(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  try {
    await fs.rm(ledgerPath(sessionId, options.dataRoot));
  } catch {
    // already gone, fine
  }
}

// ---------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------

export interface BrokenPromise {
  ts: string;
  claim_id: string;
  claim_label: string;
  matched_text: string;
  reason: string;
}

/**
 * Scan assistant text for claim phrases, reconcile against the ledger,
 * return any unfulfilled promises.
 */
export function reconcile(assistantText: string, ledger: TurnLedgerEntry[]): BrokenPromise[] {
  const broken: BrokenPromise[] = [];
  for (const claim of CLAIM_PATTERNS) {
    let re: RegExp;
    try {
      re = new RegExp(claim.text_regex, "i");
    } catch {
      continue;
    }
    const m = assistantText.match(re);
    if (!m) continue;
    if (hasEvidence(claim.evidence, ledger)) continue;
    broken.push({
      ts: new Date().toISOString(),
      claim_id: claim.id,
      claim_label: claim.promise_label,
      matched_text: m[0],
      reason: `assistant claimed "${m[0]}" but no matching tool call in this turn`,
    });
  }
  return broken;
}

function hasEvidence(ev: ClaimEvidenceShape, ledger: TurnLedgerEntry[]): boolean {
  switch (ev.kind) {
    case "any_tool":
      return ledger.length > 0;
    case "tool_called":
      return ledger.some((e) => e.tool === ev.tool);
    case "bash_contains":
      return ledger.some((e) => e.tool === "Bash" && e.input_summary.includes(ev.needle));
    case "bash_regex": {
      let re: RegExp;
      try {
        re = new RegExp(ev.pattern);
      } catch {
        return true; // bad pattern → fail open, don't false-positive a broken promise
      }
      return ledger.some((e) => e.tool === "Bash" && re.test(e.input_summary));
    }
  }
}

/** Append a broken promise to the session's append-only ledger. */
export async function recordBrokenPromise(
  sessionId: string,
  promise: BrokenPromise,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const dir = sessionDir(sessionId, options.dataRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    brokenPromisesPath(sessionId, options.dataRoot),
    JSON.stringify(promise) + "\n",
    "utf8",
  );
}

/** Read all broken promises for a session (used by next turn's hook). */
export async function readBrokenPromises(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<BrokenPromise[]> {
  try {
    const raw = await fs.readFile(brokenPromisesPath(sessionId, options.dataRoot), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as BrokenPromise);
  } catch {
    return [];
  }
}

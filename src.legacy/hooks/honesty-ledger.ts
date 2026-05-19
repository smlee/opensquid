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

import { loadBundledDefaultCodex } from "../codex/loader.js";
import { resolveDataRoot } from "../codex/store.js";
import { CodexClaimEntry, CodexClaimEvidence } from "../codex/types.js";

// ---------------------------------------------------------------------
// Claim → required-evidence catalog
// ---------------------------------------------------------------------

export type ClaimEvidenceShape =
  | { kind: "any_tool" }
  | { kind: "bash_contains"; needle: string }
  | { kind: "bash_regex"; pattern: string }
  | { kind: "tool_called"; tool: string }
  // v0.6.4: composable + tool-agnostic shapes for claim patterns that
  // can be satisfied by multiple MCP tools (e.g. telegram via plugin
  // OR opensquid chat_send) or that match against an Edit/Write file
  // path (e.g. "bumped Cargo.toml" → input_contains Edit + Cargo.toml).
  | { kind: "any_of"; options: ClaimEvidenceShape[] }
  | { kind: "input_contains"; tool: string; needle: string };

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
 * Bridge: convert a codex CodexClaimEvidence into the ledger-side
 * ClaimEvidenceShape. The two shapes overlap but differ in two ways:
 * codex uses `tool_call` while the ledger uses `tool_called` (a
 * legacy past-participle name); and codex `input_contains` carries
 * an extra `field` parameter that the ledger doesn't use.
 *
 * The bridge is the single seam where the two vocabularies are
 * reconciled — keeping it in one place means the rest of the file
 * can keep using its existing `ClaimEvidenceShape`.
 */
function codexEvidenceToLedgerEvidence(c: CodexClaimEvidence): ClaimEvidenceShape {
  switch (c.kind) {
    case "any_tool":
      return { kind: "any_tool" };
    case "tool_call":
      return { kind: "tool_called", tool: c.tool };
    case "bash_contains":
      return { kind: "bash_contains", needle: c.needle };
    case "bash_regex":
      return { kind: "bash_regex", pattern: c.pattern };
    case "input_contains":
      // Drop `field` — the ledger's input_contains matches against
      // the whole input_summary, not a specific field.
      return { kind: "input_contains", tool: c.tool, needle: c.needle };
    case "any_of":
      return {
        kind: "any_of",
        options: c.options.map(codexEvidenceToLedgerEvidence),
      };
  }
}

function codexClaimToLedgerPattern(c: CodexClaimEntry): ClaimPattern {
  return {
    id: c.id,
    text_regex: c.claim_pattern,
    evidence: codexEvidenceToLedgerEvidence(c.evidence),
    promise_label: c.unfulfilled_message,
  };
}

/**
 * Claim catalog — sourced from the bundled-default codex (0.7.17,
 * drift-as-codex chunk 3b). Previously a hand-maintained TS array;
 * now loaded once at module init from
 * `src/codex/bundled-default/codex.yaml` via the chunk-2 loader.
 *
 * Fail-open: if the codex is unloadable, the catalog is empty and
 * no claims fire. Better silent under-enforcement than a hook crash.
 */
export const CLAIM_PATTERNS: ClaimPattern[] = (() => {
  try {
    const codex = loadBundledDefaultCodex();
    return (codex.claims ?? []).map(codexClaimToLedgerPattern);
  } catch (err) {
    process.stderr.write(
      `[opensquid honesty-ledger] codex unloadable, claim catalog empty: ${err instanceof Error ? err.message : err}\n`,
    );
    return [];
  }
})();

// ---------------------------------------------------------------------
// Session-scoped ledger
// ---------------------------------------------------------------------

/**
 * One tool-call entry, persisted across ALL turns in the same Claude
 * Code session. Cleared only at session end (or explicit
 * `clearSessionLedger`).
 *
 * #114 (2026-05-15) — v0.4.C.1 fix: previously this was a PER-TURN
 * ledger that got cleared by the Stop hook, which caused recap text
 * describing prior-turn work to be flagged as broken promises. Now
 * the ledger accumulates across the whole session so claims like
 * "tests pass" satisfy against any `npm test` from any earlier turn
 * in the same session.
 */
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
  // Filename kept as `turn-ledger.jsonl` for back-compat with any
  // existing per-turn files on disk; semantics are now session-scoped.
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

/** Read the session-scoped ledger (every tool call so far this session). */
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

/**
 * Clear the session ledger. ONLY called at session end (or by tests).
 * Stop hook does NOT call this anymore — the ledger persists across
 * turns to avoid recap-text false-positives.
 */
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

/**
 * Explicit session-end clear: wipes everything opensquid wrote under
 * this session's directory — turn ledger, broken promises, plus the
 * heartbeat checkpoint and pending marker (#124). Files are removed
 * individually so unrelated files in the session dir survive (in case
 * a future hook drops something else there).
 */
export async function clearSession(
  sessionId: string,
  options: { dataRoot?: string } = {},
): Promise<void> {
  const sessionFiles = [
    ledgerPath(sessionId, options.dataRoot),
    brokenPromisesPath(sessionId, options.dataRoot),
    path.join(sessionDir(sessionId, options.dataRoot), "heartbeat-checkpoint.json"),
    path.join(sessionDir(sessionId, options.dataRoot), "heartbeat-pending.txt"),
  ];
  for (const p of sessionFiles) {
    try {
      await fs.rm(p);
    } catch {
      // ignore
    }
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
    case "any_of":
      return ev.options.some((opt) => hasEvidence(opt, ledger));
    case "input_contains":
      return ledger.some((e) => e.tool === ev.tool && e.input_summary.includes(ev.needle));
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
